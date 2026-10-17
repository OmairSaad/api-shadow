package com.example.shop

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class KtController {
    @GetMapping("/kotlin")
    fun hello() = "hi"
}
