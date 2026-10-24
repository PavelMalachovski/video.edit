"""Action job-source ставит только jsonschema (`.github/scripts/job-source.sh`) и зовёт `vm.fetch` и `vm.source`:
им нельзя тянуть numpy и модели при импорте. С 15.10 `vm.fetch` импортировал `matte` (numpy) — Action падал на
каждой задаче, и готового исходника в черновике не было ни разу: рендер и правка нормализовали видео заново (4–9 мин)."""
import subprocess
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
BLOCK = "import sys\nfor m in ('numpy', 'onnxruntime', 'sherpa_onnx', 'soundfile', 'PIL', 'fontTools'): sys.modules[m] = None\n"


def test_the_job_source_action_imports_without_numpy():
    code = BLOCK + "import vm.fetch, vm.source, vm.job\n"
    run = subprocess.run([sys.executable, "-c", code], cwd=ENGINE, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
