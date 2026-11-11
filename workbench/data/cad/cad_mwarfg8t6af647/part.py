import base64, json, sys
import build123d  # noqa: F401  (tells cad run to load the build123d integration)
from cad import model
sys.path.insert(0, "E:\\卫华黑客松\\3D-工业方案演示\\workbench\\server\\cad")
import weihua_parts

SPEC = json.loads(base64.b64decode("eyJ0ZW1wbGF0ZSI6InByb2ZpbGUiLCJwYXJhbXMiOnsicG9pbnRzIjpbWzEyMDAsMF0sWy0xMjAwLDBdLFstMTIwMCwyNjAwXSxbMTIwMCwyNjAwXV0sImRlcHRoIjoyNjAwLCJob2xlcyI6W10sImF4aXMiOiJ4In19").decode("utf-8"))


@model
def part():
    return weihua_parts.build(SPEC)


if __name__ == "__main__":
    part()
