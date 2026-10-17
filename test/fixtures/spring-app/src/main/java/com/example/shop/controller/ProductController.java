package com.example.shop.controller;

import com.example.shop.ApiPaths;
import com.example.shop.dto.ProductDto;
import com.example.shop.service.ProductService;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiPaths.V1 + "/products")
public class ProductController {

    private static final String BY_ID = "/{id}";

    @Autowired
    private ProductService productService;

    @GetMapping
    public List<ProductDto> list(@RequestParam(defaultValue = "0") int page) {
        return productService.findAll(page);
    }

    @GetMapping(BY_ID)
    public ProductDto get(@PathVariable Long id) {
        return productService.findById(id);
    }

    @PostMapping
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<ProductDto> create(@RequestBody ProductDto dto) {
        return ResponseEntity.ok(productService.create(dto));
    }

    @DeleteMapping(path = {"/{id}", "/remove/{id}"})
    public void delete(@PathVariable("id") Long id) {
        productService.delete(id);
    }

    @RequestMapping(value = "/search", method = {RequestMethod.GET, RequestMethod.POST})
    public List<ProductDto> search(@RequestParam(name = "q", required = false) String query) {
        return productService.findAll(0);
    }

    @RequestMapping("/legacy")
    public String legacy() {
        return "legacy";
    }
}
