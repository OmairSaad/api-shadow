package com.example.shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TestOnlyController {
    @GetMapping("/test-only")
    public String t() { return "t"; }
}
