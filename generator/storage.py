"""
ストレージ抽象化モジュール — v3.3

MVP: temp directory (os.path ベース)
将来: R2 バインディングに差し替え

全 I/O をこのモジュール経由にすることで、
Cloudflare 移行時の変更を1箇所に集約する。
"""

import os
import shutil
import tempfile
from typing import BinaryIO


class FileStorage:
    """
    ファイルストレージ抽象クラス。
    MVP は temp directory、将来 R2 に差し替え。
    """
    
    def __init__(self, base_dir: str | None = None):
        """
        Args:
            base_dir: ベースディレクトリ。None の場合は tempdir を自動作成。
        """
        if base_dir:
            self._base = base_dir
            self._owned = False
        else:
            self._base = tempfile.mkdtemp(prefix="ayukko_")
            self._owned = True
    
    @property
    def base_dir(self) -> str:
        return self._base
    
    def save_file(self, key: str, data: bytes) -> str:
        """
        ファイルを保存。
        
        Args:
            key: ファイルキー（パス）
            data: バイナリデータ
            
        Returns:
            保存先のフルパス
        """
        path = os.path.join(self._base, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path
    
    def save_upload(self, key: str, upload_bytes: bytes) -> str:
        """アップロードファイルを保存（save_file のエイリアス）"""
        return self.save_file(key, upload_bytes)
    
    def load_file(self, key: str) -> bytes | None:
        """
        ファイルを読み込み。
        
        Args:
            key: ファイルキー（パス）
            
        Returns:
            バイナリデータ。存在しない場合は None。
        """
        path = os.path.join(self._base, key)
        if not os.path.exists(path):
            return None
        with open(path, "rb") as f:
            return f.read()
    
    def get_path(self, key: str) -> str:
        """キーからフルパスを取得"""
        return os.path.join(self._base, key)
    
    def exists(self, key: str) -> bool:
        """ファイルが存在するか"""
        return os.path.exists(os.path.join(self._base, key))
    
    def cleanup(self):
        """temp directory の場合はクリーンアップ"""
        if self._owned and os.path.exists(self._base):
            shutil.rmtree(self._base, ignore_errors=True)
    
    def __enter__(self):
        return self
    
    def __exit__(self, *args):
        self.cleanup()


# ── Future: R2 implementation ──
# class R2Storage(FileStorage):
#     """Cloudflare R2 binding-based storage"""
#     def __init__(self, r2_bucket):
#         self._bucket = r2_bucket
#     
#     def save_file(self, key, data):
#         self._bucket.put(key, data)
#         return key
#     
#     def load_file(self, key):
#         obj = self._bucket.get(key)
#         return obj.body if obj else None
