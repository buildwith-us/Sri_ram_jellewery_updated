import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import { getApiBaseUrl } from '../../utils/apiConfig';

const Footer = () => {
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [isSubscribing, setIsSubscribing] = useState(false);

  const handleNewsletterSubmit = (e) => {
    e.preventDefault();
    setIsSubscribing(true);
    axios
      .post(`${getApiBaseUrl()}/newsletter`, { email: newsletterEmail })
      .then((res) => {
        toast.success(res.data.message || 'Subscribed successfully');
        setNewsletterEmail('');
      })
      .catch((error) => {
        toast.error(error.response?.data?.error || 'Failed to subscribe');
      })
      .finally(() => setIsSubscribing(false));
  };

  return (
    <footer
      // Extra room at the bottom, so the floating WhatsApp button never sits
      // over the last row (the copyright line, the newsletter's send button).
      className="w-full bg-surface-container-low border-t border-primary/10 pt-section-gap-sm pb-24"
    >
      <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-16 mb-20">
          {/* Brand Info */}
          <div className="md:col-span-4 space-y-8">
            <div className="flex flex-col gap-4">
              <Link className="mb-6 block" to="/">
              <img alt="SRJ Heritage Logo" className="h-20 w-auto object-contain self-start" src="/images/logo.png" />
            </Link>
              <h4 className="font-display-lg text-[22px] text-primary">Sri Ram Jewellery</h4>
            </div>
            <p className="font-body-base text-on-surface-variant leading-relaxed max-w-sm italic">
              Timeless Craftsmanship. Celebrating your milestones with the purest gold and finest diamonds since 1984.
            </p>
            <div className="flex gap-5">
              <a className="w-10 h-10 rounded-full border border-primary/20 flex items-center justify-center text-primary hover:bg-primary hover:text-white transition-ui" href="#">
                <span className="material-symbols-outlined text-[20px]">public</span>
              </a>
              <a className="w-10 h-10 rounded-full border border-primary/20 flex items-center justify-center text-primary hover:bg-primary hover:text-white transition-ui" href="#">
                <span className="material-symbols-outlined text-[20px]">photo_camera</span>
              </a>
            </div>
          </div>

          {/* Links Columns */}
          <div className="md:col-span-2 space-y-8">
            <h4 className="font-label-caps text-xs text-primary uppercase tracking-[0.2em] font-bold">Quick Links</h4>
            <nav className="flex flex-col gap-4">
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/">Home</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/shop">Shop</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/shop?category=gold">Categories</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/about">About</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/contact">Contact</Link>
            </nav>
          </div>

          <div className="md:col-span-2 space-y-8">
            <h4 className="font-label-caps text-xs text-primary uppercase tracking-[0.2em] font-bold">Policies</h4>
            <nav className="flex flex-col gap-4">
              {/* These four pointed at "/" — four dead links in the footer of
                  every page. Razorpay activation checks that policies resolve. */}
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal/privacy-policy">Privacy Policy</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal/terms-of-service">Terms of Service</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal/shipping-policy">Shipping Info</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal/return-policy">Returns &amp; Exchange</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal/cancellation-policy">Cancellation</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/help">Help Centre</Link>
              <Link className="font-body-base text-on-surface-variant hover:text-primary transition-colors flex items-center min-h-11" to="/legal">All policies</Link>
            </nav>
          </div>

          {/* Newsletter */}
          <div className="md:col-span-4 space-y-8">
            <h4 className="font-label-caps text-xs text-primary uppercase tracking-[0.2em] font-bold">Newsletter</h4>
            <p className="font-body-base text-on-surface-variant">
              Join our circle for early access to new collections and gold rate alerts.
            </p>
            <form className="flex border border-primary/20 rounded-sm overflow-hidden group focus-within:ring-1 focus-within:ring-primary/40 transition-ui" onSubmit={handleNewsletterSubmit}>
              <input
                className="flex-1 bg-white/50 border-none focus:ring-0 px-5 py-3 text-body-base text-on-surface placeholder:text-on-surface-variant/40"
                placeholder="Email Address"
                required
                type="email"
                value={newsletterEmail}
                onChange={(e) => setNewsletterEmail(e.target.value)}
                disabled={isSubscribing}
              />
              <button className="bg-primary text-white px-8 flex items-center justify-center hover:bg-primary/90 transition-ui disabled:opacity-70" type="submit" disabled={isSubscribing}>
                <span className="material-symbols-outlined">send</span>
              </button>
            </form>
          </div>
        </div>

        <div className="pt-10 border-t border-primary/10 text-center">
          <p className="font-label-caps text-[10px] text-on-surface-variant uppercase tracking-[0.3em]">
            © {new Date().getFullYear()} SRI RAM JEWELLERY. TIMELESS CRAFTSMANSHIP. ALL RIGHTS RESERVED.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
