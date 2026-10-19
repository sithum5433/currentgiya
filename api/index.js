import { createServer } from '../server.mjs';

let appHandler;

export default async function handler(req, res) {
  if (!appHandler) {
    process.env.DATA_DIR = process.env.DATA_DIR || '/tmp';
    process.env.TRUST_PROXY = '1';
    process.env.CLIENT_IP_HEADER = 'x-forwarded-for';
    const server = await createServer({
      dataFile: '/tmp/state.json'
    });
    appHandler = server.listeners('request')[0];
  }
  return appHandler(req, res);
}
