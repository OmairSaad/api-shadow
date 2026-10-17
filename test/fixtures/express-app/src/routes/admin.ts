import express from 'express';

export const adminRouter = express.Router();

adminRouter.get('/stats', (_req, res) => res.json({}));
adminRouter.delete('/cache', (_req, res) => res.sendStatus(204));
