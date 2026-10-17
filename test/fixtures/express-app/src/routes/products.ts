import { Router, Request, Response } from 'express';
import { ProductService } from '../services/product.service';

const router = Router();
const productService = new ProductService();
const BASE = '/';

router.get(BASE, (req: Request, res: Response) => {
  res.json(productService.list());
});

router.get('/:productId(\\d+)', async (req, res) => {
  res.json(await productService.get(Number(req.params.productId)));
});

router.get(['/featured', '/top'], (_req, res) => res.json([]));

router.get(/^\/legacy-.*$/, (_req, res) => res.sendStatus(410));

export default router;
