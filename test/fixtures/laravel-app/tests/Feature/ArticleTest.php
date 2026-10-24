<?php

namespace Tests\Feature;

use Tests\TestCase;

class ArticleTest extends TestCase
{
    public function test_lists_articles(): void
    {
        $this->getJson('/api/articles')->assertOk();
    }

    public function test_requires_auth_to_create(): void
    {
        $this->postJson('/api/articles', ['title' => 'x'])->assertUnauthorized();
    }
}
