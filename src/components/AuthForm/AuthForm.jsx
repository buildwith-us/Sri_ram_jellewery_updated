import React from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import CustomHelmet from "../CustomHelmet/CustomHelmet";
import useOtpAuthFlow from "../../hooks/useOtpAuthFlow";
import OtpAuthSteps, { stepHeading } from "../OtpAuthSteps/OtpAuthSteps";

/**
 * The full-page sign-in used by /login and /register. Same flow and the same
 * forms as the sign-in modal (useOtpAuthFlow + OtpAuthSteps), including the
 * Sign in / Create account switch. /login opens on Sign in (email → code),
 * /register on Create account (name + phone → email → code).
 *
 * Reached directly, by PrivateRoute (state.from), or after a session expired.
 */
const AuthForm = ({ helmetTitle, heroEyebrow, heroHeadline, initialMode = "signin" }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get("reason") === "session-expired";

  let from = location.state?.from?.pathname || "/";
  if (from.includes("dashboard")) from = "/";

  const flow = useOtpAuthFlow({
    initialMode,
    onSignedIn: ({ isNewAccount, user }) => {
      if (isNewAccount) {
        // A new account sees the short onboarding once, then carries on.
        navigate("/welcome", { replace: true, state: { from } });
      } else {
        toast.success(user?.name ? `Welcome back, ${user.name}!` : "You're signed in");
        navigate(from, { replace: true });
      }
    },
  });
  const heading = stepHeading(flow);

  return (
    <main className="w-full min-h-screen flex font-body-base bg-surface text-on-surface">
      <CustomHelmet title={helmetTitle} />

      {/* Left: Editorial image panel */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage:
              "url('https://lh3.googleusercontent.com/aida-public/AB6AXuDPsFrWztD4iPFFVXzCkBPEfyBStgI3PNvxZHYaG2xk_d1nosHS5vyaq9K_uwZdvntEmcJtGPU1Q9IA6MPJTJaKdJ7LkmxSMEQrro0eYkE0QP6KpW6K7_x_F3poPHVg_ZM6jrDlVagpaUF05lVzfr2CGrOvwLpgVfi2zeH7r94YoPzdWIuVUMZ79DrWDv5Z6ZJDZvBFhl3pZh_ucp_8E0fVJ3FrcM7qv-4etClKOvw7wgmsTNnARVdj6aoukBw790ysmQkfJORH8YM')",
          }}
        ></div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/30"></div>
        <div className="relative z-10 flex flex-col justify-between h-full p-16 text-white">
          <span className="font-label-caps text-label-caps tracking-[0.3em] uppercase opacity-90">{heroEyebrow}</span>
          <h2 className="font-display-lg text-headline-md leading-tight max-w-md">{heroHeadline}</h2>
        </div>
      </div>

      {/* Right: Form panel */}
      <div className="w-full lg:w-1/2 flex flex-col items-center justify-center px-6 py-20 md:px-16">
        <div className="w-full max-w-[400px]">
          <div className="text-center mb-10">
            <Link to="/">
              <img alt="Sri Ram Jewellery" className="h-14 w-auto mx-auto object-contain mb-6" src="/logo.png" />
            </Link>
            <span className="font-label-caps text-[11px] text-primary uppercase tracking-[0.2em] block mb-2">
              {heading.eyebrow}
            </span>
            <h1 className="font-display-lg text-headline-md text-on-surface mb-2">{heading.title}</h1>
            <p className="font-body-base text-on-surface-variant text-sm">{heading.subtitle}</p>
          </div>

          {/* Why they are here, when they did not choose to be. Only on the
              first step, and never alongside a real error. */}
          {sessionExpired && !flow.error && flow.step === "email" && (
            <div className="w-full mb-6 p-4 border border-secondary/40 bg-secondary/10 text-on-surface text-sm flex items-start gap-2 rounded-sm">
              <span className="material-symbols-outlined text-[20px] text-secondary flex-none" aria-hidden="true">
                schedule
              </span>
              <span>
                Your session expired, so we signed you out. Sign in again to pick up where you left off — your cart
                and wishlist are saved.
              </span>
            </div>
          )}

          <OtpAuthSteps key={`${flow.step}:${flow.email}`} flow={flow} idPrefix="auth-page" />


          <div className="flex items-center justify-center gap-2 mt-12 text-on-surface-variant/60">
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">verified_user</span>
            <p className="font-label-caps text-[9px] uppercase tracking-widest text-center leading-relaxed">
              Secure sign-in by Sri Ram Jewellery
              <br />
              Protecting your personal collection since 1984
            </p>
          </div>
        </div>
      </div>
    </main>
  );
};

export default AuthForm;
