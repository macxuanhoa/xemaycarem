import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, Field, Loading } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "./AuthProvider";

const changePasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(6, "Mật khẩu phải có ít nhất 6 ký tự")
      .max(128, "Mật khẩu tối đa 128 ký tự"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Mật khẩu xác nhận không khớp",
    path: ["confirmPassword"],
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

export default function ChangePasswordPage() {
  const { profile, loading, refresh } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
  });

  const requestedPath = (location.state as { from?: unknown } | null)?.from;
  const returnTo = (() => {
    if (typeof requestedPath !== "string") return "/";
    try {
      const destination = new URL(requestedPath, window.location.origin);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname === "/change-password"
      )
        return "/";
      return destination.pathname + destination.search + destination.hash;
    } catch {
      return "/";
    }
  })();

  if (loading) return <Loading />;
  if (!profile) return <Navigate to="/login" replace />;
  if (!profile.must_change_password) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    if (!supabase) return;

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: values.newPassword,
      });

      if (updateError) throw updateError;

      // Clear must_change_password flag via secure RPC
      const { error: profileError } = await supabase.rpc(
        "complete_password_change",
      );

      if (profileError) throw profileError;

      setSuccess(true);
      await refresh();
    } catch (e) {
      setError(e);
    }
  });

  if (success) {
    return (
      <div className="auth-simple">
        <div className="card stack">
          <h1>Mật khẩu đã được cập nhật</h1>
          <p>Bạn có thể tiếp tục sử dụng hệ thống.</p>
          <Button onClick={() => navigate(returnTo, { replace: true })}>
            Tiếp tục
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-simple">
      <div className="card stack">
        <h1>Đổi mật khẩu</h1>
        <p className="muted">
          Bạn cần đổi mật khẩu trước khi tiếp tục sử dụng hệ thống.
        </p>
        <form onSubmit={onSubmit} className="stack">
          <Field label="Mật khẩu mới" error={errors.newPassword?.message}>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Nhập mật khẩu mới (tối thiểu 6 ký tự)"
              {...register("newPassword")}
            />
          </Field>
          <Field
            label="Xác nhận mật khẩu"
            error={errors.confirmPassword?.message}
          >
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Nhập lại mật khẩu mới"
              {...register("confirmPassword")}
            />
          </Field>
          {error != null && (
            <p className="field-error" role="alert">
              {friendlyError(error)}
            </p>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Đang cập nhật..." : "Cập nhật mật khẩu"}
          </Button>
        </form>
      </div>
    </div>
  );
}
