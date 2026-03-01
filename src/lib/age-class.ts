/**
 * 年齢クラス判定ロジック
 * 
 * ユーザー指示:
 *   月極利用児: 「0歳児」「1歳児」「2歳児」
 *   一時利用児: 「一時」
 *   
 *   令和7年度 (fiscal_year 2025, i.e. 2025/4~2026/3):
 *     0歳児: 2024/4/2 〜
 *     1歳児: 2023/4/2 〜 2024/4/1
 *     2歳児: 2022/4/2 〜 2023/4/1
 * 
 * 一般ルール: fiscal_year=N のとき
 *   age_class=A の範囲: (N-1-A)/4/2 〜 (N-A)/4/1
 */

/**
 * 対象月からfiscal_yearを計算
 * 4月〜3月 → fiscal_year = 4月の属する年
 */
export function getFiscalYear(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

/**
 * 生年月日からage_class (歳児クラス) を判定
 * @param birthDate "YYYY-MM-DD" 形式
 * @param fiscalYear 年度 (e.g. 2025 = 令和7年度)
 * @returns 0〜5 の歳児クラス、判定不能の場合は null
 */
export function getAgeClassFromBirthDate(birthDate: string, fiscalYear: number): number | null {
  if (!birthDate) return null;

  const parts = birthDate.split('-');
  if (parts.length !== 3) return null;

  const bYear = parseInt(parts[0]);
  const bMonth = parseInt(parts[1]);
  const bDay = parseInt(parts[2]);

  if (isNaN(bYear) || isNaN(bMonth) || isNaN(bDay)) return null;

  // 年度開始日 = fiscal_year/4/2 (4/2が新年度の起点)
  // age_class A: (fiscal_year - 1 - A)/4/2 <= birth_date <= (fiscal_year - A)/4/1
  for (let ageClass = 0; ageClass <= 5; ageClass++) {
    const startYear = fiscalYear - 1 - ageClass;
    const endYear = fiscalYear - ageClass;

    // Range: startYear/4/2 <= birthDate <= endYear/4/1
    const rangeStart = new Date(startYear, 3, 2); // April 2
    const rangeEnd = new Date(endYear, 3, 1);     // April 1

    const birth = new Date(bYear, bMonth - 1, bDay);

    if (birth >= rangeStart && birth <= rangeEnd) {
      return ageClass;
    }
  }

  // 0歳児 should also cover children born after fiscal_year-1/4/2
  // (i.e., born in the current fiscal year — very young babies)
  const youngestStart = new Date(fiscalYear - 1, 3, 2); // April 2 of fiscal_year-1
  const birth = new Date(bYear, bMonth - 1, bDay);
  if (birth >= youngestStart) {
    return 0;
  }

  return null;
}

/**
 * age_class (0-5) → クラス名
 */
export function ageClassToLabel(ageClass: number | null, enrollmentType: string): string {
  if (enrollmentType === '一時') return '一時';
  if (ageClass === null || ageClass === undefined) return '不明';
  return `${ageClass}歳児`;
}

/**
 * age_class → 料金計算用グループ
 */
export function getAgeGroup(ageClass: number): string {
  if (ageClass <= 2) return '0~2歳';
  if (ageClass === 3) return '3歳';
  return '4~5歳';
}
