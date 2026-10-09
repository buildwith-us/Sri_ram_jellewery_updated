import React, { useState } from "react";

/**
 * The forms for each step of useOtpAuthFlow. Shared by <AuthModal /> and the
 * /login and /register pages, so both look and behave the same.
 */

const inputClass =
  "w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/40 transition-ui duration-300 outline-none focus:border-primary font-body-base";
const labelClass = "font-label-caps text-[11px] text-on-surface-variant uppercase tracking-[0.2em] mb-2 block";
const primaryButton =
  "w-full bg-primary text-on-primary py-4 font-button-text uppercase tracking-[0.2em] text-[12px] hover:bg-primary-container transition-ui duration-300 active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-70 cursor-pointer";
const linkButton =
  "text-on-surface-variant font-label-caps text-[10px] uppercase tracking-widest hover:text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed min-h-11";

/** Heading copy for each step, for whichever container renders the steps. */
export const stepHeading = (flow) =>
  ({
    email: {
      eyebrow: "Sign in or create an account",
      title: "Welcome",
      subtitle: "Enter your email and we'll send you a 6-digit code. No password needed.",
    },
    code: {
      eyebrow: "Check your inbox",
      title: "Enter your code",
      subtitle: `We sent a 6-digit code to ${flow.email}. It expires in 5 minutes.`,
    },
    details: {
      eyebrow: "Almost there",
      title: "Your details",
      subtitle: "So we know who to address, and the number to call about your delivery.",
    },
  })[flow.step];

const Spinner = () => <span className="loading loading-spinner loading-md" aria-hidden="true"></span>;

const OtpAuthSteps = ({ flow, idPrefix = "auth" }) => {
  const [emailValue, setEmailValue] = useState(flow.email || "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const id = (s) => `${idPrefix}-${s}`;

  return (
    <div>
      <div aria-live="assertive" className="min-h-0">
        {flow.error && (
          <p role="alert" className="mb-6 p-4 bg-error-container text-on-error-container text-sm font-semibold rounded-sm">
            {flow.error}
          </p>
        )}
      </div>

      {flow.step === "email" && (
        <form
          className="space-y-8"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            flow.submitEmail(emailValue);
          }}
        >
          <div>
            <label className={labelClass} htmlFor={id("email")}>
              Email address
            </label>
            <input
              id={id("email")}
              className={inputClass}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              value={emailValue}
              onChange={(e) => setEmailValue(e.target.value)}
              data-autofocus
            />
          </div>
          <button type="submit" className={primaryButton} disabled={flow.busy || !emailValue.trim()}>
            {flow.busy ? <Spinner /> : "Send code"}
          </button>
        </form>
      )}

      {flow.step === "code" && (
        <form
          className="space-y-8"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            flow.submitCode(code);
          }}
        >
          <div>
            <label className={labelClass} htmlFor={id("code")}>
              6-digit code
            </label>
            <input
              id={id("code")}
              className={`${inputClass} tracking-[0.6em] text-center text-xl`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="••••••"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              data-autofocus
            />
          </div>
          <button type="submit" className={primaryButton} disabled={flow.busy || code.length !== 6}>
            {flow.busy ? <Spinner /> : "Verify & continue"}
          </button>
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              className={linkButton}
              onClick={() => flow.resend()}
              disabled={flow.busy || flow.resendIn > 0}
              aria-live="polite"
            >
              {flow.resendIn > 0 ? `Resend code in ${flow.resendIn}s` : "Resend code"}
            </button>
            <button type="button" className={linkButton} onClick={flow.changeEmail} disabled={flow.busy}>
              Use a different email
            </button>
          </div>
        </form>
      )}

      {flow.step === "details" && (
        <form
          className="space-y-8"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            flow.submitDetails({ name, phone });
          }}
        >
          <div>
            <label className={labelClass} htmlFor={id("name")}>
              Your name
            </label>
            <input
              id={id("name")}
              className={inputClass}
              type="text"
              autoComplete="name"
              placeholder="Full name"
              maxLength={100}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={id("phone")}>
              Mobile number
            </label>
            <input
              id={id("phone")}
              className={inputClass}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="98765 43210"
              maxLength={20}
              required
              aria-describedby={id("phone-help")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p id={id("phone-help")} className="text-on-surface-variant/80 text-xs mt-1.5">
              We call this number about your delivery.
            </p>
          </div>
          <button type="submit" className={primaryButton} disabled={flow.busy || !name.trim() || !phone.trim()}>
            {flow.busy ? <Spinner /> : "Continue"}
          </button>
        </form>
      )}
    </div>
  );
};

export default OtpAuthSteps;
