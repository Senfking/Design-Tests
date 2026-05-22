"""Synthesize a wide 'car on white' image and pipe it through pad_to_square."""
from PIL import Image, ImageDraw
from to_square import pad_to_square

# Fake studio shot: 1600x900, near-white background, dark "car" silhouette in the middle.
w, h = 1600, 900
img = Image.new("RGB", (w, h), (248, 248, 246))
d = ImageDraw.Draw(img)
# body
d.rounded_rectangle([300, 380, 1300, 620], radius=60, fill=(35, 45, 60))
# roof
d.polygon([(560, 380), (820, 250), (1080, 250), (1180, 380)], fill=(40, 50, 65))
# windows
d.polygon([(600, 380), (840, 285), (1060, 285), (1140, 380)], fill=(150, 175, 195))
# wheels
d.ellipse([380, 560, 540, 720], fill=(20, 20, 20))
d.ellipse([1060, 560, 1220, 720], fill=(20, 20, 20))
d.ellipse([410, 590, 510, 690], fill=(70, 70, 70))
d.ellipse([1090, 590, 1190, 690], fill=(70, 70, 70))

img.save("/tmp/mbcars/fake_in.jpg", "JPEG", quality=92)
sq = pad_to_square(img, size=1024)
sq.save("/tmp/mbcars/fake_out.jpg", "JPEG", quality=92)
print("input :", img.size)
print("output:", sq.size)
