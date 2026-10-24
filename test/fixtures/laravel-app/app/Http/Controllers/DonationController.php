<?php

namespace App\Http\Controllers;

use App\Models\Donation;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DonationController extends Controller
{
    public function store(Request $request)
    {
        $total = DB::select("SELECT SUM(amount) AS total FROM donations WHERE donor = '" . $request->input('donor') . "'");
        $donation = Donation::create($request->all());
        return response()->json(['id' => $donation->id, 'amount' => $donation->amount, 'total' => $total], 201);
    }
}
