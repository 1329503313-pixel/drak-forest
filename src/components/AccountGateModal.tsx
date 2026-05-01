import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  initialNickname: string;
  initialAvatar: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: { gameAccountId: string; nickname: string; avatar: string }) => void;
};

export function AccountGateModal({
  open,
  initialNickname,
  initialAvatar,
  submitting,
  error,
  onSubmit,
}: Props) {
  const [account, setAccount] = useState("");

  useEffect(() => {
    if (open) {
      setAccount("");
    }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    onSubmit({
      gameAccountId: account.trim(),
      nickname: initialNickname,
      avatar: initialAvatar,
    });
  };

  return (
    <div className="overlay overlay--blocking" role="dialog" aria-modal="true" aria-labelledby="account-gate-title">
      <div className="modal modal--account">
        <h3 id="account-gate-title">请输入你的游戏账号</h3>
        <p className="modal-hint">
          游戏账号会绑定你的昵称、头像和对局记录。若账号已存在，将自动读取该账号资料；若是新账号，会直接创建。
        </p>
        <label className="field-label" htmlFor="account-gate-id">
          游戏账号
        </label>
        <input
          id="account-gate-id"
          className="account-input"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="2–24 位字母、数字、中文、下划线或短横线"
          maxLength={24}
          autoComplete="username"
          autoFocus
        />
        {error ? (
          <p className="modal-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={submitting || account.trim().length < 2}
            onClick={submit}
          >
            {submitting ? "提交中…" : "确认并登录"}
          </button>
        </div>
      </div>
    </div>
  );
}
