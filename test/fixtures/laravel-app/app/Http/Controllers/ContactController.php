<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class ContactController extends Controller
{
    public function index() { return []; }
    public function show($id) { return ['id' => $id]; }
    public function store(Request $request) { return response()->json(['id' => 1], 201); }
    public function update(Request $request, $id) { return ['id' => $id]; }
    public function destroy($id) { return response()->noContent(); }
}
