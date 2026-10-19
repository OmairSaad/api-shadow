package com.example.shop.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MockMvc;

class ProductControllerTest {
    @Autowired
    private MockMvc mvc;

    void listsProducts() throws Exception {
        mvc.perform(get("/shop/api/v1/products")).andExpect(status().isOk());
    }
}
