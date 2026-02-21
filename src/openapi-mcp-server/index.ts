import { Client } from '@notionhq/client';

// 直接从 Render 环境变量读取，不再依赖 Kelivo 传参
const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

export { notion };
// 保留原有的导出以防报错
export { OpenAPIToMCPConverter } from './openapi/parser';
export { HttpClient } from './client/http-client';
