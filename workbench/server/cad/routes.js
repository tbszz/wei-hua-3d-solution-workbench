// REST for parametric CAD parts (text-to-cad). Mounted after the JSON body parser.
import express from 'express';
import { buildPart, buildFromDrawing, cadStatus, TEMPLATES } from './index.js';

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error('[cad]', error);
    res.status(status).json({ ok: false, error: error.message });
  }
};

export function createCadRouter() {
  const router = express.Router();
  router.get('/api/cad/status', handle(() => cadStatus()));
  router.get('/api/cad/templates', handle(() => ({ ok: true, templates: TEMPLATES })));
  router.post('/api/cad/part', handle((req) => buildPart(req.body ?? {})));
  router.post('/api/cad/from-drawing', handle((req) => buildFromDrawing(req.body ?? {})));
  return router;
}
