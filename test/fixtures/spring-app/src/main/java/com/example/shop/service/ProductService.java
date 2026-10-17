package com.example.shop.service;

import com.example.shop.dto.ProductDto;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class ProductService {
    public List<ProductDto> findAll(int page) {
        return List.of();
    }

    public ProductDto findById(Long id) {
        return null;
    }

    public ProductDto create(ProductDto dto) {
        return dto;
    }

    public void delete(Long id) {}
}
