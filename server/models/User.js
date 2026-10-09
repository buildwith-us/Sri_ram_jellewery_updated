import mongoose from "mongoose";

const AddressSchema = new mongoose.Schema({
  label: { type: String, default: "Home" },
  fullName: { type: String },
  phone: { type: String },
  addressLine1: { type: String },
  addressLine2: { type: String },
  city: { type: String },
  state: { type: String },
  pincode: { type: String },
  country: { type: String, default: "India" },
  isDefault: { type: Boolean, default: false },
}, { _id: true });

const UserSchema = new mongoose.Schema({
  name: { type: String },
  // Display address. For a customer, the address as they typed it when they
  // first signed in; for an administrator, their password-login address.
  email: { type: String, unique: true, sparse: true },
  // Customer sign-in identity: the normalised address (utils/emailIdentity.js).
  // The only field the email-code routes look an account up by. NEVER set on
  // an administrator account, so no email code can reach one.
  emailKey: { type: String },
  // An address a customer typed before email became the sign-in identity. It
  // was never verified, so it grants nothing and is kept only to contact them.
  contactEmail: { type: String },
  passwordHash: { type: String }, // bcrypt hash — never store plaintext
  phone: { type: String, unique: true, sparse: true }, // unique and required for customers
  otpHash: { type: String }, // For MSG91 OTP
  otpExpiresAt: { type: Date },
  role: { type: String, enum: ["ADMIN", "USER"], default: "USER" },
  photoURL: { type: String },
  addresses: { type: [AddressSchema], default: [] },
  shippingAddress: { type: Object },
  createdAt: { type: Date, default: Date.now },
});

// Unique only where present, so phone-only and administrator accounts (which
// have no emailKey) never collide with each other.
UserSchema.index(
  { emailKey: 1 },
  { unique: true, partialFilterExpression: { emailKey: { $type: "string" } } }
);

export const User = mongoose.model("User", UserSchema);
