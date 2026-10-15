"""Key naming: pitch class + mode -> Camelot code and Rekordbox classic name (same tables as export.js)."""

from dataclasses import dataclass

NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_CAM = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
MAJOR_CAM = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
_ALIASES = {"C#": "Db", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb", "Cb": "B", "Fb": "E", "E#": "F", "B#": "C"}


@dataclass(frozen=True)
class Key:
    pc: int  # pitch class of the tonic, 0 = C
    minor: bool
    strength: float = 0.0  # detector confidence, 0..1 where available

    @property
    def camelot(self) -> str:
        return f"{(MINOR_CAM if self.minor else MAJOR_CAM)[self.pc]}{'A' if self.minor else 'B'}"

    @property
    def classic(self) -> str:
        return NAMES[self.pc] + ("m" if self.minor else "")

    def name(self, notation: str) -> str:
        return self.camelot if notation == "camelot" else self.classic


def pitch_class(note: str) -> int:
    note = _ALIASES.get(note, note)
    return NAMES.index(note)


def parse(text: str) -> Key | None:
    """Parses '8A', 'Am', 'F#m', 'Bb' as written by Rekordbox or Key Master."""
    s = (text or "").strip()
    if not s:
        return None
    if s[-1] in "ABab" and s[:-1].isdigit():
        n, minor = int(s[:-1]), s[-1] in "Aa"
        table = MINOR_CAM if minor else MAJOR_CAM
        return Key(table.index(n), minor) if n in table else None
    minor = s.endswith("m") and len(s) > 1
    root = s[:-1] if minor else s
    try:
        return Key(pitch_class(root), minor)
    except ValueError:
        return None
