/** 待审核数量变化事件：上传/审核操作后派发，Layout 角标监听后重新拉取 */
export const PENDING_REVIEW_CHANGED = 'ekh:pending-review-changed';

export const notifyPendingReviewChanged = () => {
  window.dispatchEvent(new Event(PENDING_REVIEW_CHANGED));
};
