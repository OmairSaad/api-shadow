<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\ArticleController;
use App\Http\Controllers\EventController;
use App\Http\Controllers\CategoryController;
use App\Http\Controllers\PriestController;
use App\Http\Controllers\DonationController;

// 1. Simple routes with actions
Route::post('/login', [AuthController::class, 'login']);

// 2. Resource routes limited to specific actions
Route::apiResource('articles', ArticleController::class)->only(['index', 'show']);
Route::apiResource('events', EventController::class)->only(['index', 'show']);
Route::apiResource('messages', ContactController::class);
Route::apiResource('priest', PriestController::class)->only(['index', 'show']);

// 3. Protected Route Group with Middleware
Route::group(['middleware' => 'auth:sanctum'], function () {
    Route::post('/logout', [AuthController::class, 'logout']);
    
    // Nested resources or actions requiring auth
    Route::apiResource('articles', ArticleController::class)->except(['index', 'show']);
    Route::apiResource('categories', CategoryController::class);
    Route::apiResource('priest', PriestController::class)->except(['index', 'show']);
});

// 4. Routes with url parameters
Route::get('/events/{id}/test-recurrence', [EventController::class, 'testRecurrence']);

// 5. Standalone resource action
Route::post('/payment', [DonationController::class, 'store']);
