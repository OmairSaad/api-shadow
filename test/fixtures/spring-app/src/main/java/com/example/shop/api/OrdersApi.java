package com.example.shop.api;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/api/orders")
public interface OrdersApi {
    @GetMapping
    List<String> list();

    @GetMapping("/{orderId}")
    String get(@PathVariable("orderId") String orderId);
}
