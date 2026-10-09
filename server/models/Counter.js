import mongoose from "mongoose";

/**
 * Named sequences, incremented atomically ($inc on one document), so two
 * requests in the same millisecond still get different numbers. Used for the
 * daily order-number sequence: _id "order:20261009" → seq 1, 2, 3 …
 */
const CounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

export const Counter = mongoose.model("Counter", CounterSchema);
