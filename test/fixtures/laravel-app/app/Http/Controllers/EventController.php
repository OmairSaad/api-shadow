<?php

namespace App\Http\Controllers;

use App\Models\Event;
use Illuminate\Support\Facades\DB;

class EventController extends Controller
{
    public function index()
    {
        return Event::latest()->paginate(20);
    }

    public function show($id)
    {
        return Event::findOrFail($id);
    }

    public function testRecurrence($id)
    {
        try {
            $event = Event::findOrFail($id);
            return response()->json(['next' => $event->nextOccurrence(), 'count' => 3]);
        } catch (\Exception $e) {
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }
}
