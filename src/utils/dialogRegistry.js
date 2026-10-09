import { useEffect, useId } from "react";
import Swal from "sweetalert2";

/**
 * The one answer to "is a dialog already open?".
 *
 * The timed sign-in prompt must never appear on top of another dialog. Rather
 * than each caller checking the cart drawer, the image zoom, the quote modal
 * and SweetAlert separately, every dialog registers here while it is open and
 * this module is the only thing that is asked.
 *
 * SweetAlert2 is opened imperatively from many files (confirmations, errors),
 * so instead of registering each call it is probed here, in the same place.
 */

const open = new Set();

/** Mark a dialog open; returns the function that marks it closed. */
export const registerDialog = (id) => {
  open.add(id);
  return () => open.delete(id);
};

/** True while any registered dialog, or a SweetAlert2 popup, is open. */
export const isAnyDialogOpen = ({ except } = {}) => {
  for (const id of open) if (id !== except) return true;
  try {
    if (Swal.isVisible()) return true;
  } catch {
    /* SweetAlert not initialised — nothing is showing */
  }
  return false;
};

/**
 * Register a component's dialog for as long as `isOpen` is true.
 * Returns the id it registered under (for `except`).
 */
export const useRegisterDialog = (name, isOpen) => {
  const id = `${name}:${useId()}`;
  useEffect(() => {
    if (!isOpen) return undefined;
    return registerDialog(id);
  }, [id, isOpen]);
  return id;
};
