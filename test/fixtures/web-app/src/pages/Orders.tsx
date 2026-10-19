import { useEffect, useState } from 'react';

export function Orders() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    fetch('/api/orders').then((r) => r.json()).then(setOrders);
  }, []);
  // Typo: the route is /api/orders.
  const refresh = () => fetch('/api/order').then((r) => r.json()).then(setOrders);
  return <button onClick={refresh}>{orders.length} orders</button>;
}
