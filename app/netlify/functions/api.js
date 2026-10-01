// Netlify Functions adapter: run the Express app via serverless-http.
// server.js only calls app.listen() when run directly, so importing it here is
// safe and the same app (routes, middleware, CSP) serves Netlify.
import serverless from 'serverless-http';
import app from '../../src/server.js';

export const handler = serverless(app);
