/**
 * 食事フラグ自動判定（SSOT: Single Source of Truth）
 * 
 * このモジュールが食事フラグの唯一の計算元です。
 * 全ての入力経路（LINE会話、LIFF/Web、管理画面）で共通利用してください。
 * 
 * 設計原則:
 *   - 保護者は「日付・登園時間・降園時間」の3項目のみ入力
 *   - 食事は園側管理。保護者に入力させない
 *   - 時間帯から自動判定
 * 
 * 木村さん確定ルール (2026-03-10):
 *   - 12時前に登園 → 昼食あり
 *   - 15時以降に降園 → 午後おやつあり
 *   - 19時以降に登園（夜間保育） → 朝食あり
 *   - 12時前に登園 → 朝食あり（通常保育）
 * 
 * 未確定（木村さんに確認中。現在は0固定）:
 *   - 午前おやつ (am_snack_flag)
 *   - 夕食 (dinner_flag)
 */

export interface MealFlags {
  breakfast_flag: number;
  lunch_flag: number;
  am_snack_flag: number;
  pm_snack_flag: number;
  dinner_flag: number;
}

/**
 * 登降園時間から食事フラグを自動判定
 */
export function calculateMealFlags(start: string, end: string): MealFlags {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  
  // 夜間保育: 19時以降に登園
  const isNightCare = startMinutes >= timeToMinutes('19:00');
  
  return {
    // 12時前に登園 → 朝食あり、または夜間保育 → 朝食あり
    breakfast_flag: (startMinutes < timeToMinutes('12:00') || isNightCare) ? 1 : 0,
    // 12時前に登園 → 昼食あり
    lunch_flag: startMinutes < timeToMinutes('12:00') ? 1 : 0,
    // 午前おやつ: 未確定（木村さん確認待ち）→ 0固定
    am_snack_flag: 0,
    // 15時以降に降園 → 午後おやつあり
    pm_snack_flag: endMinutes >= timeToMinutes('15:00') ? 1 : 0,
    // 夕食: 未確定（木村さん確認待ち）→ 0固定
    dinner_flag: 0,
  };
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
