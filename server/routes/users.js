import express from "express";
import bcrypt from "bcrypt";
import { User } from "../models/User.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";
import mongoose from "mongoose";
import { validate, updateProfileSchema, changePasswordSchema, shippingAddressSchema, adminUpdateUserSchema } from "../middleware/validate.js";
import { normalizeIndianPhone } from "../utils/phone.js";
import { profileStatus } from "../utils/profile.js";

const BCRYPT_SALT_ROUNDS = 12;

const router = express.Router();

// Never sent back in any user response: the password hash, and the sign-in
// code's hash and expiry. A bcrypt hash of a 6-digit code can be brute-forced
// offline within its 5-minute life, so it is as sensitive as the code itself.
const HIDDEN_USER_FIELDS = "-passwordHash -otpHash -otpExpiresAt";

// ─── Current User Profile ────────────────────────────────────────────────────

// GET /api/users/me — get authenticated user's profile
router.get("/me", verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select(HIDDEN_USER_FIELDS)
      .lean();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      success: true,
      data: {
        ...user,
        admin: user.role === "ADMIN",
        ...profileStatus(user),
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// PATCH /api/users/me — update authenticated user's profile
router.patch("/me", verifyJWT, validate(updateProfileSchema), async (req, res) => {
  try {
    // `email` never reaches here: updateProfileSchema refuses it, because the
    // address is the verified sign-in identity. Only these fields are written.
    const { name, phone, photoURL } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (photoURL !== undefined) updateData.photoURL = photoURL;

    // The delivery contact number. No longer a sign-in identity, but still one
    // per account: normalised to +91XXXXXXXXXX so spellings cannot dodge the
    // unique index, and a number already on another account is refused.
    if (phone !== undefined) {
      const normalized = normalizeIndianPhone(phone);
      if (!normalized.ok) {
        return res.status(400).json({ error: normalized.reason });
      }

      const owner = await User.findOne({ phone: normalized.phone });
      if (owner && String(owner._id) !== String(req.user.userId)) {
        return res
          .status(409)
          .json({ error: "That mobile number is already linked to another account" });
      }

      updateData.phone = normalized.phone;
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      Object.keys(updateData).length ? { $set: updateData } : {},
      { new: true }
    )
      .select(HIDDEN_USER_FIELDS)
      .lean();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, data: { ...user, ...profileStatus(user) } });
  } catch (error) {
    // The check above is a courtesy, not the guarantee. Two requests can both
    // pass it and race to write; the unique index is what actually prevents a
    // shared address, and it reports that as E11000. Translate it into the same
    // 409 the pre-check returns, so a lost race reads as a collision rather
    // than as the server breaking.
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({
        error:
          field === "phone"
            ? "That mobile number is already linked to another account"
            : "That email address is already linked to another account",
      });
    }
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Failed to update user profile" });
  }
});

// PATCH /api/users/me/password — change authenticated user's password
router.patch("/me/password", verifyJWT, validate(changePasswordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (!user.passwordHash) {
      return res.status(400).json({ error: "This account does not use a password. Sign in with OTP instead." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await user.save();

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// ─── Addresses ───────────────────────────────────────────────────────────────

// PATCH /api/users/shipping-address
router.patch("/shipping-address", verifyJWT, validate(shippingAddressSchema), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $set: { shippingAddress: req.body } },
      { new: true }
    ).select(HIDDEN_USER_FIELDS);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, modifiedCount: 1, data: user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update address" });
  }
});

// PATCH /api/users/delete-address
router.patch("/delete-address", verifyJWT, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $unset: { shippingAddress: "" } },
      { new: true }
    ).select(HIDDEN_USER_FIELDS);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, modifiedCount: 1, data: user });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete address" });
  }
});

// GET /api/users/me/addresses
router.get("/me/addresses", verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("addresses").lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ success: true, data: user.addresses || [] });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

// POST /api/users/me/addresses
router.post("/me/addresses", verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const address = {
      _id: new mongoose.Types.ObjectId(),
      ...req.body,
    };

    // If this is the first address or marked as default, set it as default
    if (user.addresses.length === 0 || req.body.isDefault) {
      user.addresses.forEach(a => a.isDefault = false);
      address.isDefault = true;
    }

    user.addresses.push(address);
    await user.save();

    res.status(201).json({ success: true, data: address });
  } catch (error) {
    res.status(500).json({ error: "Failed to add address" });
  }
});

// PATCH /api/users/me/addresses/:id
router.patch("/me/addresses/:id", verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const address = user.addresses.id(req.params.id);
    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    // If setting as default, unset others
    if (req.body.isDefault) {
      user.addresses.forEach(a => a.isDefault = false);
    }

    Object.assign(address, req.body);
    await user.save();

    res.json({ success: true, data: address });
  } catch (error) {
    res.status(500).json({ error: "Failed to update address" });
  }
});

// DELETE /api/users/me/addresses/:id
router.delete("/me/addresses/:id", verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const address = user.addresses.id(req.params.id);
    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    address.deleteOne();
    await user.save();

    res.json({ success: true, message: "Address deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete address" });
  }
});

// ─── Admin User Management ──────────────────────────────────────────────────

// GET /api/users — admin list all users
router.get("/", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select(HIDDEN_USER_FIELDS).lean();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/**
 * Would changing or removing this account leave the shop with no
 * administrator who can sign in? Counts only ADMIN accounts with a password —
 * an admin record without one cannot reach the dashboard.
 */
const isLastUsableAdmin = async (target) => {
  if (target.role !== "ADMIN") return false;
  const others = await User.countDocuments({
    _id: { $ne: target._id },
    role: "ADMIN",
    passwordHash: { $exists: true, $nin: [null, ""] },
  });
  return others === 0;
};

const LAST_ADMIN_ERROR =
  "There must always be at least one administrator who can sign in. Make another account an admin first.";

// PATCH /api/users/:id — admin update user
router.patch("/:id", verifyJWT, requireAdmin, validate(adminUpdateUserSchema), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    // Only an account that signs in with a password can be an administrator.
    // A customer signs in with an emailed code, and that path must never
    // produce an admin session — so customers cannot be promoted. To make a
    // customer an administrator, create an admin account for them instead.
    if (req.body.role === "ADMIN" && target.role !== "ADMIN" && (!target.passwordHash || target.emailKey)) {
      return res.status(400).json({
        error: "Only accounts that sign in with a password can be administrators. Customer accounts can't be promoted.",
      });
    }

    // Demoting the last administrator would lock everyone out of the dashboard.
    if (req.body.role === "USER" && (await isLastUsableAdmin(target))) {
      return res.status(400).json({ error: LAST_ADMIN_ERROR });
    }

    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.role !== undefined) updates.role = req.body.role;

    const user = await User.findByIdAndUpdate(target._id, { $set: updates }, { new: true }).select(HIDDEN_USER_FIELDS);
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update user" });
  }
});

// DELETE /api/users/:id — admin delete user
router.delete("/:id", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, message: "User deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
