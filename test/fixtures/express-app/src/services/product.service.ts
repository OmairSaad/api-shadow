export class ProductService {
  list(): unknown[] {
    return [];
  }

  async get(id: number): Promise<unknown> {
    return { id };
  }
}
