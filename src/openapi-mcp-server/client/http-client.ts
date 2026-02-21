import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import OpenAPIClientAxios from 'openapi-client-axios'
import type { AxiosInstance } from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import { Headers } from './polyfill-headers'
import { isFileUploadParameter } from '../openapi/file-upload'

export type HttpClientConfig = {
  baseUrl: string
  headers?: Record<string, string>
}

export type HttpClientResponse<T = any> = {
  data: T
  status: number
  headers: Headers
}

export class HttpClientError extends Error {
  constructor(
    public message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`)
    this.name = 'HttpClientError'
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>
  private client: OpenAPIClientAxios

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    // @ts-expect-error
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'notion-mcp-server',
          // 强制注入 Notion 认证头
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          ...config.headers,
        },
      },
    })
    this.api = this.client.init()
  }

  private async prepareFileUpload(operation: OpenAPIV3.OperationObject, params: Record<string, any>): Promise<FormData | null> {
    const fileParams = isFileUploadParameter(operation)
    if (fileParams.length === 0) return null
    const formData = new FormData()
    for (const param of fileParams) {
      const filePath = params[param]
      if (!filePath) throw new Error(`File path must be provided for parameter: ${param}`)
      const addFile = (name: string, path: string) => {
        try {
          const fileStream = fs.createReadStream(path)
          formData.append(name, fileStream)
        } catch (error) {
          throw new Error(`Failed to read file at ${path}: ${error}`)
        }
      }
      if (typeof filePath === 'string') addFile(param, filePath)
      else if (Array.isArray(filePath)) filePath.forEach(file => addFile(param, file))
      else throw new Error(`Unsupported file type: ${typeof filePath}`)
    }
    for (const [key, value] of Object.entries(params)) {
      if (!fileParams.includes(key)) formData.append(key, value)
    }
    return formData
  }

  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api
    const operationId = operation.operationId
    if (!operationId) throw new Error('Operation ID is required')

    const formData = await this.prepareFileUpload(operation, params)
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = formData || { ...params }

    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ('name' in param && param.name && param.in) {
          if (param.in === 'path' || param.in === 'query') {
            if (params[param.name] !== undefined) {
              urlParameters[param.name] = params[param.name]
              if (!formData) delete bodyParams[param.name]
            }
          }
        }
      }
    }

    if (!operation.requestBody && !formData) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key]
          delete bodyParams[key]
        }
      }
    }

    const operationFn = (api as any)[operationId]
    if (!operationFn) throw new Error(`Operation ${operationId} not found`)

    try {
      const hasBody = Object.keys(bodyParams).length > 0
      const headers = formData
        ? formData.getHeaders()
        : { ...(hasBody ? { 'Content-Type': 'application/json' } : {}) }
      
      const requestConfig = {
        headers: {
          ...headers,
          // 再次确保 POST 请求也带上 Token
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28'
        },
      }

      const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig)
      const responseHeaders = new Headers()
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString())
      })

      return { data: response.data, status: response.status, headers: responseHeaders }
    } catch (error: any) {
      if (error.response) {
        const headers = new Headers()
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString())
        })
        throw new HttpClientError(error.response.statusText || 'Request failed', error.response.status, error.response.data, headers)
      }
      throw error
    }
  }
}
