// Netlify Functions entry: the whole Express app (API + SPA + legacy pages)
// runs serverless. server.js only listens when executed directly, so
// importing the default-exported app is side-effect free here.
import serverless from 'serverless-http';
import app from '../../src/server.js';

export const handler = serverless(app);
