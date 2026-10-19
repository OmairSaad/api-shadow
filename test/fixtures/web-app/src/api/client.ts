import axios from 'axios';

export const shop = axios.create({ baseURL: 'http://localhost:8080/shop/api/v1' });

export async function getUser(id: string) {
  const res = await fetch(`/api/v1/users/${id}`);
  return res.json();
}

export function createUser(name: string) {
  return axios.post('/api/v1/users', { name });
}

export function searchProducts(q: string) {
  return shop.get(`/products/search?q=${encodeURIComponent(q)}`);
}

export function loadProduct(id: number) {
  return shop.get(`/products/${id}`);
}
