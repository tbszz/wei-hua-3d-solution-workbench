import base64, json, sys
import build123d  # noqa: F401  (tells cad run to load the build123d integration)
from cad import model
sys.path.insert(0, "E:\\卫华黑客松\\3D-工业方案演示\\workbench\\server\\cad")
import weihua_parts

SPEC = json.loads(base64.b64decode("eyJ0ZW1wbGF0ZSI6InByb2ZpbGUiLCJwYXJhbXMiOnsicG9pbnRzIjpbWzEyNTAsMTI1MF0sWzEyMDcuNDEsMTU3My41Ml0sWzEwODIuNTMsMTg3NV0sWzg4My44OCwyMTMzLjg4XSxbNjI1LDIzMzIuNTNdLFszMjMuNTIsMjQ1Ny40MV0sWzAsMjUwMF0sWy0zMjMuNTIsMjQ1Ny40MV0sWy02MjUsMjMzMi41M10sWy04ODMuODgsMjEzMy44OF0sWy0xMDgyLjUzLDE4NzVdLFstMTIwNy40MSwxNTczLjUyXSxbLTEyNTAsMTI1MF0sWy0xMjA3LjQxLDkyNi40OF0sWy0xMDgyLjUzLDYyNV0sWy04ODMuODgsMzY2LjEyXSxbLTYyNSwxNjcuNDddLFstMzIzLjUyLDQyLjU5XSxbMCwwXSxbMzIzLjUyLDQyLjU5XSxbNjI1LDE2Ny40N10sWzg4My44OCwzNjYuMTJdLFsxMDgyLjUzLDYyNV0sWzEyMDcuNDEsOTI2LjQ4XV0sImRlcHRoIjoyNTAwLCJob2xlcyI6W10sImF4aXMiOiJ4In19").decode("utf-8"))


@model
def part():
    return weihua_parts.build(SPEC)


if __name__ == "__main__":
    part()
