package com.example.shop.service;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    public List<String> list() {
        return List.of();
    }

    public String get(String id) {
        return id;
    }
}
