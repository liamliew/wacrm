"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { oauthRedirectUrl } from "@/lib/auth/callback";
import { Button } from "@/components/ui/button";

interface GoogleSignInButtonProps {
  /** Same-origin path to land on after sign-in (/dashboard, /join/<token>). */
  next: string;
  label: string;
  onError: (message: string) => void;
}

// Starts Supabase's Google OAuth (PKCE) flow. The browser leaves for
// Google and returns to /auth/callback, which exchanges the code for a
// session cookie and forwards to `next`. Supabase must allow the
// callback under Authentication → URL Configuration → Redirect URLs and
// have the Google provider enabled; see docs/auth-emails.md.
export function GoogleSignInButton({
  next,
  label,
  onError,
}: GoogleSignInButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: oauthRedirectUrl(window.location.origin, next) },
    });
    // On success the browser is already navigating to Google.
    if (error) {
      onError(error.message);
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      disabled={loading}
      onClick={handleClick}
      className="h-10 w-full gap-2 border-border text-foreground hover:bg-muted disabled:opacity-50"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.5 12.27c0-.82-.07-1.6-.21-2.36H12v4.46h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.72z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1A12 12 0 0 0 12 24z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28v-3.1H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.38l4-3.1z"
        />
        <path
          fill="#EA4335"
          d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.62l4 3.1C6.22 6.88 8.87 4.77 12 4.77z"
        />
      </svg>
      {label}
    </Button>
  );
}
