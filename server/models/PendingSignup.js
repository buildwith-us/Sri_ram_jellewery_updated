import mongoose from "mongoose";

/**
 * A sign-in code sent to an address that has no account yet.
 *
 * No User record exists until that code is verified: requesting a code used
 * to create one on the spot, so every address anyone typed — mistyped,
 * abandoned or someone else's — became a customer in the admin users table.
 * The code waits here instead, and the account is created at verification
 * together with the name and phone the customer gave (routes/auth.js).
 *
 * Only the bcrypt hash of the code is stored, as on the User record.
 */
const PendingSignupSchema = new mongoose.Schema({
  emailKey: { type: String, required: true, unique: true },
  // The address as the customer typed it, for the account's display email.
  email: { type: String },
  otpHash: { type: String, required: true },
  otpExpiresAt: { type: Date, required: true },
});

// TTL index — MongoDB removes the record once the code expires, so an
// abandoned sign-up leaves nothing behind.
PendingSignupSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const PendingSignup = mongoose.model("PendingSignup", PendingSignupSchema);

export default PendingSignup;
