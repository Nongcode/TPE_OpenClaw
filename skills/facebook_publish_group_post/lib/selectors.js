export const SELECTORS = {
  pageBlockedBanner: [
    'text=/không cho phép các trang tham gia/i',
    'text=/does not allow pages to join/i',
  ],

  composerTrigger: [
    'role=button[name=/Bạn viết gì đi/i]',
    'role=button[name=/Viết bài/i]',
    'role=button[name=/Bắt đầu thảo luận/i]',
    'role=button[name=/Tạo bài viết/i]',
    'role=button[name=/What\'s on your mind/i]',
    'role=button[name=/Write something/i]',
  ],

  composerDialog: 'role=dialog',

  composerTextbox: [
    'role=dialog >> role=textbox',
    'div[role="dialog"] div[contenteditable="true"]',
  ],

  photoVideoButton: [
    'role=dialog >> role=button[name=/Ảnh\\/video/i]',
    'role=dialog >> role=button[name=/Photo\\/video/i]',
    'role=dialog >> [aria-label=/Ảnh\\/video/i]',
  ],

  fileInput: 'role=dialog >> input[type="file"]',

  submitButton: [
    'role=dialog >> role=button[name=/^Đăng$/i]',
    'role=dialog >> role=button[name=/^Post$/i]',
  ],

  joinGroupButton: [
    'role=button[name=/^Tham gia nhóm$/i]',
    'role=button[name=/^Join group$/i]',
  ],

  pendingApprovalIndicator: [
    'text=/yêu cầu của bạn đang chờ/i',
    'text=/your request is pending/i',
    'text=/đã yêu cầu/i',
  ],
};

export function buildBlockedDetector(page) {
  return async () => {
    for (const sel of SELECTORS.pageBlockedBanner) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 500 })) return true;
      } catch {}
    }
    return false;
  };
}

export async function findFirstVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 200 })) return loc;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
