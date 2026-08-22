import { buildApp } from './app.js';

const app = buildApp();
const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`trivia server on http://localhost:${port}`);
