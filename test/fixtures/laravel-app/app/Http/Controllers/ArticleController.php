<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreArticleRequest;
use App\Models\Article;
use App\Services\ArticleService;
use Illuminate\Http\Request;

class ArticleController extends Controller
{
    public function __construct(private ArticleService $articles)
    {
    }

    public function index()
    {
        return response()->json(['data' => $this->articles->latest(), 'meta' => ['total' => Article::count()]]);
    }

    public function show(Article $article)
    {
        return ['id' => $article->id, 'title' => $article->title, 'body' => $article->body, 'published' => true];
    }

    public function store(StoreArticleRequest $request)
    {
        $article = Article::create($request->validated());
        return response()->json($article, 201);
    }

    public function update(Request $request, Article $article)
    {
        $article->update($request->all());
        return response()->json($article);
    }

    public function destroy(Article $article)
    {
        $article->delete();
        return response()->noContent();
    }
}
