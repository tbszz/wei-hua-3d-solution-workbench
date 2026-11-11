import base64, json, sys
import build123d  # noqa: F401  (tells cad run to load the build123d integration)
from cad import model
sys.path.insert(0, "E:\\卫华黑客松\\3D-工业方案演示\\workbench\\server\\cad")
import weihua_parts

SPEC = json.loads(base64.b64decode("eyJ0ZW1wbGF0ZSI6InByb2ZpbGUiLCJwYXJhbXMiOnsicG9pbnRzIjpbWy04MDAsMF0sWy04MDAsMjMwMF0sWzgwMCwyMzAwXSxbODAwLDBdXSwiZGVwdGgiOjIzMDAsImhvbGVzIjpbW1stNjUwLDUwXSxbLTY1MCwyMjUwXSxbLTQ3MCwyMjUwXSxbLTQ3MCw1MF1dLFtbMTUwLDUwXSxbMTUwLDIyNTBdLFszMzAsMjI1MF0sWzMzMCw1MF1dLFtbNjUwLDUwXSxbNjUwLDIyNTBdLFs0NzAsMjI1MF0sWzQ3MCw1MF1dLFtbLTE1MCw1MF0sWy0xNTAsMjI1MF0sWy0zMzAsMjI1MF0sWy0zMzAsNTBdXV0sImF4aXMiOiJ4In19").decode("utf-8"))


@model
def part():
    return weihua_parts.build(SPEC)


if __name__ == "__main__":
    part()
