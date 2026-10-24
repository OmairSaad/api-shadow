<?php

namespace App\Services;

use App\Models\Article;

class ArticleService
{
    public function latest()
    {
        return Article::latest()->take(10)->get();
    }
}
