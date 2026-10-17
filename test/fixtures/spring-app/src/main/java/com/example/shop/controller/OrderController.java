package com.example.shop.controller;

import com.example.shop.api.OrdersApi;
import com.example.shop.service.OrderService;
import java.util.List;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController implements OrdersApi {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @Override
    public List<String> list() {
        return orderService.list();
    }

    @Override
    public String get(String orderId) {
        return this.orderService.get(orderId);
    }
}
