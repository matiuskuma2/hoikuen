"""
名前正規化エンジン (SSOT) — v3.1 Phase B-0
全パーサー・突合で統一して使う正規化ルール

B-0: これを最初に固定すると全体が堅くなる

正規化ルール:
  1. 全角英数 → 半角英数
  2. 全角スペース → 半角スペース
  3. 中点（・）, ＝, 連続スペース → 単一スペース
  4. カタカナ: 半角 → 全角（ｱ→ア）
  5. 前後空白除去

突合キー生成:
  1. 正規化済みフルネーム ("田中 太郎")
  2. スペースなし ("田中太郎")
  3. 姓のみ ("田中")
  4. 名のみ ("太郎")

突合優先度:
  1. ルクミーID 完全一致
  2. 正規化フルネーム完全一致
  3. スペースなしフルネーム完全一致
  4. 姓のみ一致（候補1名のみ）
"""

import re
import unicodedata


# ── Half-width katakana → Full-width katakana mapping ──
_HW_KANA_MAP = str.maketrans(
    'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ',
    'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜'
)

# Dakuten/Handakuten combos  (e.g. ｶﾞ→ガ, ﾊﾟ→パ)
_DAKUTEN_MAP = {
    'カ゛': 'ガ', 'キ゛': 'ギ', 'ク゛': 'グ', 'ケ゛': 'ゲ', 'コ゛': 'ゴ',
    'サ゛': 'ザ', 'シ゛': 'ジ', 'ス゛': 'ズ', 'セ゛': 'ゼ', 'ソ゛': 'ゾ',
    'タ゛': 'ダ', 'チ゛': 'ヂ', 'ツ゛': 'ヅ', 'テ゛': 'デ', 'ト゛': 'ド',
    'ハ゛': 'バ', 'ヒ゛': 'ビ', 'フ゛': 'ブ', 'ヘ゛': 'ベ', 'ホ゛': 'ボ',
    'ウ゛': 'ヴ',
    'ハ゜': 'パ', 'ヒ゜': 'ピ', 'フ゜': 'プ', 'ヘ゜': 'ペ', 'ホ゜': 'ポ',
}


def normalize_name(name: str) -> str:
    """
    名前正規化（Single Source of Truth）

    Steps:
      1. 全角英数 → 半角英数 (Ａ→A, ０→0)
      2. 全角スペース → 半角スペース
      3. 半角カタカナ → 全角カタカナ (ｱ→ア, ｶﾞ→ガ)
      4. 区切り記号除去 (・, ·, ＝, =)
      5. 連続スペース → 単一スペース
      6. 前後空白除去

    Example:
      "Ｍｏｎｄａｌ　Ａｕｍ" → "Mondal Aum"
      "田中　太郎" → "田中 太郎"
      "ﾀﾅｶ ﾀﾛｳ" → "タナカ タロウ"
      "田中・太郎" → "田中 太郎"
    """
    if not name:
        return ""

    # Step 1: 全角英数 → 半角英数
    result = []
    for ch in name:
        cp = ord(ch)
        # Fullwidth ASCII variants (！→! ... ～→~)
        if 0xFF01 <= cp <= 0xFF5E:
            result.append(chr(cp - 0xFEE0))
        # Fullwidth space
        elif ch == '\u3000':
            result.append(' ')
        else:
            result.append(ch)
    s = ''.join(result)

    # Step 2: Half-width katakana → Full-width katakana
    s = s.translate(_HW_KANA_MAP)

    # Step 3: Combine dakuten/handakuten
    for combo, replacement in _DAKUTEN_MAP.items():
        s = s.replace(combo, replacement)

    # Step 4: Remove separator symbols → space
    s = s.replace('・', ' ').replace('·', ' ').replace('＝', ' ').replace('=', ' ')

    # Step 5: Collapse spaces
    s = re.sub(r'\s+', ' ', s)

    # Step 6: Strip
    s = s.strip()

    return s


def extract_surname(name: str) -> str:
    """姓を抽出（スペース区切りの最初の部分）"""
    parts = normalize_name(name).split(' ')
    return parts[0] if parts else ""


def extract_firstname(name: str) -> str:
    """名を抽出（スペース区切りの2番目以降）"""
    parts = normalize_name(name).split(' ')
    return ' '.join(parts[1:]) if len(parts) > 1 else ""


def generate_match_keys(name: str) -> list[str]:
    """
    突合用キーを複数生成（優先度順）
      1. 正規化済みフルネーム  "田中 太郎"
      2. スペースなしフルネーム "田中太郎"
      3. 姓のみ                "田中"
      4. 名のみ                "太郎"
    """
    norm = normalize_name(name)
    keys = [norm]

    # スペースなし版
    no_space = norm.replace(' ', '')
    if no_space != norm:
        keys.append(no_space)

    # 姓のみ
    surname = extract_surname(name)
    if surname and surname != norm and surname != no_space:
        keys.append(surname)

    # 名のみ (same-surname disambiguation)
    firstname = extract_firstname(name)
    if firstname and firstname != norm and firstname != no_space:
        keys.append(firstname)

    return keys


# ── Children Matching Engine ──

def match_children(
    lukumi_children: list[dict],
    schedule_names: list[str],
    roster_children: list[dict],
) -> tuple[list[dict], list[dict], list[str]]:
    """
    園児突合エンジン

    優先順位:
      1. ルクミー園児ID (最安定)
      2. 正規化名完全一致
      3. スペースなし名一致
      4. 姓のみ一致（候補1名のみ）

    Returns:
      (matched_children, warnings, unmatched_names)
    """
    warnings = []

    # ── Build master indices from Lukumi (SSOT for IDs) ──
    children_by_id: dict[str, dict] = {}
    children_by_norm: dict[str, dict] = {}
    children_by_nospace: dict[str, dict] = {}
    children_by_surname: dict[str, list[dict]] = {}

    children: list[dict] = []

    for lc in lukumi_children:
        child = {
            "id": lc.get("lukumi_id", ""),
            "lukumi_id": lc.get("lukumi_id", ""),
            "name": lc["name"],
            "name_norm": normalize_name(lc["name"]),
            "name_kana": lc.get("name_kana"),
            "age_class": lc.get("age_class"),
            "enrollment_type": lc.get("enrollment_type", "月極"),
            "child_order": lc.get("child_order", 1),
            "is_allergy": lc.get("is_allergy", 0),
            "birth_date": lc.get("birth_date"),
            "class_name": lc.get("class_name", ""),
            # Phase B-4 tracking
            "has_schedule": False,
            "schedule_file": None,
        }

        children.append(child)

        if child["lukumi_id"]:
            children_by_id[child["lukumi_id"]] = child

        norm = child["name_norm"]
        children_by_norm[norm] = child
        children_by_nospace[norm.replace(' ', '')] = child

        surname = extract_surname(norm)
        if surname:
            children_by_surname.setdefault(surname, []).append(child)

    # ── Enrich from roster (B-2 data) ──
    for rc in roster_children:
        rc_norm = normalize_name(rc.get("name", ""))
        rc_nospace = rc_norm.replace(' ', '')

        target = children_by_norm.get(rc_norm) or children_by_nospace.get(rc_nospace)
        if target:
            if rc.get("age_class") is not None:
                target["age_class"] = rc["age_class"]
            if rc.get("enrollment_type"):
                target["enrollment_type"] = rc["enrollment_type"]
            if rc.get("birth_date"):
                target["birth_date"] = rc["birth_date"]
            if rc.get("roster_no") is not None:
                target["roster_no"] = rc["roster_no"]
            if rc.get("is_allergy") is not None:
                target["is_allergy"] = rc["is_allergy"]

    # ── Match schedule names to children (B-4) ──
    unmatched: list[str] = []
    schedule_match_results: list[dict] = []

    for sname in schedule_names:
        snorm = normalize_name(sname)
        snospace = snorm.replace(' ', '')
        ssurname = extract_surname(sname)

        match_method = None
        matched_child = None

        # Priority 1: Exact normalized match
        if snorm in children_by_norm:
            matched_child = children_by_norm[snorm]
            match_method = "exact"

        # Priority 2: No-space match
        elif snospace in children_by_nospace:
            matched_child = children_by_nospace[snospace]
            match_method = "nospace"
            warnings.append({
                "level": "info",
                "child_name": sname,
                "message": f"予定表「{sname}」→名簿「{matched_child['name']}」にスペース補正で突合",
                "suggestion": None,
            })

        # Priority 3: Surname-only match (single candidate)
        elif ssurname in children_by_surname:
            candidates = children_by_surname[ssurname]
            if len(candidates) == 1:
                matched_child = candidates[0]
                match_method = "surname"
                warnings.append({
                    "level": "warn",
                    "child_name": sname,
                    "message": f"予定表「{sname}」→姓一致で「{matched_child['name']}」に突合",
                    "suggestion": "正式名が異なる場合は手動で確認してください",
                })
            else:
                # Multiple candidates with same surname
                warnings.append({
                    "level": "error",
                    "child_name": sname,
                    "message": f"予定表「{sname}」: 同姓の園児が{len(candidates)}名いるため自動突合できません ({', '.join(c['name'] for c in candidates)})",
                    "suggestion": "ルクミーIDまたはフルネームで突合してください",
                })

        if matched_child:
            matched_child["has_schedule"] = True
            matched_child["schedule_file"] = sname
            schedule_match_results.append({
                "schedule_name": sname,
                "matched_name": matched_child["name"],
                "lukumi_id": matched_child["lukumi_id"],
                "method": match_method,
            })
        else:
            unmatched.append(sname)
            if not any(w.get("child_name") == sname and "同姓" in w.get("message", "") for w in warnings):
                warnings.append({
                    "level": "error",
                    "child_name": sname,
                    "message": f"予定表「{sname}」に一致する園児が見つかりません",
                    "suggestion": "ルクミーデータに登録がないか、名前の表記が異なる可能性があります",
                })

    return children, warnings, unmatched


def generate_submission_report(
    children: list[dict],
    schedule_names: list[str],
) -> dict:
    """
    B-4: 提出状況レポート生成

    Returns:
      {
        "submitted": [{"name": ..., "lukumi_id": ..., "schedule_file": ...}],
        "not_submitted": [{"name": ..., "lukumi_id": ..., "reason": ...}],
        "unmatched_schedules": [{"schedule_name": ..., "reason": ...}],
        "summary": {"total_children": N, "submitted": N, "not_submitted": N, "unmatched": N},
      }
    """
    submitted = []
    not_submitted = []

    norm_schedule_set = {normalize_name(sn) for sn in schedule_names}
    nospace_schedule_set = {normalize_name(sn).replace(' ', '') for sn in schedule_names}

    for c in children:
        if c.get("has_schedule"):
            submitted.append({
                "name": c["name"],
                "lukumi_id": c.get("lukumi_id"),
                "schedule_file": c.get("schedule_file"),
            })
        else:
            reason = "利用予定表が未提出です"
            # Check if name partially matches
            c_norm = normalize_name(c["name"])
            c_nospace = c_norm.replace(' ', '')
            if c_nospace in nospace_schedule_set:
                reason = "スペース差異で不一致（手動確認推奨）"
            not_submitted.append({
                "name": c["name"],
                "lukumi_id": c.get("lukumi_id"),
                "reason": reason,
            })

    # Unmatched schedule files
    matched_norms = {normalize_name(c["name"]) for c in children if c.get("has_schedule")}
    matched_nospaces = {n.replace(' ', '') for n in matched_norms}
    unmatched_schedules = []
    for sn in schedule_names:
        sn_norm = normalize_name(sn)
        sn_nospace = sn_norm.replace(' ', '')
        if sn_norm not in matched_norms and sn_nospace not in matched_nospaces:
            unmatched_schedules.append({
                "schedule_name": sn,
                "reason": "ルクミー登降園データに該当する園児なし",
            })

    return {
        "submitted": submitted,
        "not_submitted": not_submitted,
        "unmatched_schedules": unmatched_schedules,
        "summary": {
            "total_children": len(children),
            "submitted": len(submitted),
            "not_submitted": len(not_submitted),
            "unmatched": len(unmatched_schedules),
        },
    }
