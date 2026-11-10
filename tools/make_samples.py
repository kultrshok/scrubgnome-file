#!/usr/bin/env python3
"""Generate leaky sample files (fake identity: Pat Example / ACME Example) for the self-test.
Dev-only: needs python-docx, openpyxl, python-pptx, reportlab, pikepdf, piexif, pillow,
LibreOffice (soffice) and ffmpeg. The generated files are committed under tools/samples/.
Usage: python3 tools/make_samples.py tools/samples"""
import zipfile, io, re, os, shutil, subprocess, datetime
from docx import Document
from docx.shared import Inches
import openpyxl
from openpyxl.comments import Comment
from openpyxl.worksheet.table import Table
from pptx import Presentation
from pptx.util import Inches as PI
import os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else "samples"
os.makedirs(OUT, exist_ok=True)
JPG = os.path.join(OUT, "_gps.jpg")
from PIL import Image
import piexif
_e = {"0th": {piexif.ImageIFD.Make: b"Google", piexif.ImageIFD.Model: b"Pixel 8 Pro", piexif.ImageIFD.Artist: b"Pat Example", piexif.ImageIFD.DateTime: b"2026:11:07 18:35:22"}, "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:11:07 18:35:22", piexif.ExifIFD.BodySerialNumber: b"SN12345"}, "GPS": {piexif.GPSIFD.GPSLatitudeRef: b"N", piexif.GPSIFD.GPSLatitude: ((33, 1), (26, 1), (5424, 100)), piexif.GPSIFD.GPSLongitudeRef: b"W", piexif.GPSIFD.GPSLongitude: ((112, 1), (4, 1), (2664, 100))}}
Image.new("RGB", (320, 200), (200, 120, 40)).save(JPG, exif=piexif.dump(_e), quality=90)
# ---- DOCX
d=Document(); cp=d.core_properties
cp.author="Pat Example"; cp.last_modified_by="pexample"; cp.title="Secret plan"; cp.created=datetime.datetime(2026,11,7,18,0); cp.revision=7
d.add_paragraph("Hello world, this is the body text.")
d.add_picture(JPG, width=Inches(2))
d.save(OUT+"/report.docx")
# inject Word-isms
zin=zipfile.ZipFile(OUT+"/report.docx"); parts={i.filename:zin.read(i) for i in zin.infolist()}; zin.close()
doc=parts["word/document.xml"].decode()
doc=doc.replace("<w:p>",'<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">',1)
doc=doc.replace("</w:body>",'<w:p><w:ins w:id="9" w:author="Pat Example" w:date="2026-11-08T10:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins><w:commentRangeStart w:id="1"/><w:r><w:t>noted</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p></w:body>')
parts["word/document.xml"]=doc.encode()
parts["word/comments.xml"]=b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="Pat Example" w:date="2026-11-08T11:00:00Z" w:initials="ZM"><w:p><w:r><w:t>check this</w:t></w:r></w:p></w:comment></w:comments>'
parts["word/people.xml"]=b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Pat Example"><w15:presenceInfo w15:providerId="AD" w15:userId="S::pat@example.com::abc"/></w15:person></w15:people>'
parts["docProps/thumbnail.jpeg"]=open(JPG,"rb").read()
parts["docProps/custom.xml"]=b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ClientName"><vt:lpwstr>ACME</vt:lpwstr></property></Properties>'
app=parts["docProps/app.xml"].decode().replace("</Properties>","<Company>ACME Example</Company><Manager>Boss</Manager><TotalTime>143</TotalTime></Properties>")
parts["docProps/app.xml"]=app.encode()
st=parts["word/settings.xml"].decode().replace("<w:zoom",'<w:attachedTemplate r:id="rIdT"/><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/></w:rsids><w:zoom',1)
if 'xmlns:r=' not in st.split(">",2)[1]: st=st.replace("<w:settings ",'<w:settings xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',1)
parts["word/settings.xml"]=st.encode()
parts["word/_rels/settings.xml.rels"]=b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:\\Users\\pexample\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm" TargetMode="External"/></Relationships>'
rels=parts["_rels/.rels"].decode().replace("</Relationships>",'<Relationship Id="rIdTh" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/><Relationship Id="rIdC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>')
parts["_rels/.rels"]=rels.encode()
dr=parts["word/_rels/document.xml.rels"].decode().replace("</Relationships>",'<Relationship Id="rIdCm" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdPp" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/></Relationships>')
parts["word/_rels/document.xml.rels"]=dr.encode()
ct=parts["[Content_Types].xml"].decode().replace("</Types>",'<Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>')
parts["[Content_Types].xml"]=ct.encode()
with zipfile.ZipFile(OUT+"/report.docx","w",zipfile.ZIP_DEFLATED) as z:
    for k,v in parts.items(): z.writestr(k,v)
# ---- XLSX
wb=openpyxl.Workbook(); ws=wb.active; wb.properties.creator="Pat Example"; wb.properties.lastModifiedBy="pexample"
ws.append(["a","b"]); ws.append([1,2]); ws.append([3,4])
ws["A2"].comment=Comment("budget note","Pat Example")
t=Table(displayName="BudgetTable", ref="A1:B3"); ws.add_table(t)
wb.save(OUT+"/budget.xlsx")
# ---- PPTX
p=Presentation(); p.core_properties.author="Pat Example"; p.core_properties.last_modified_by="pexample"
s=p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text="Deck"; s.shapes.add_picture(JPG,PI(1),PI(1),PI(2))
p.save(OUT+"/deck.pptx")
# ---- ODT via LibreOffice
subprocess.run(["soffice","--headless","--convert-to","odt","--outdir",OUT,OUT+"/report.docx"],capture_output=True)
# ---- PDF
from reportlab.pdfgen import canvas
c=canvas.Canvas(OUT+"/flyer.pdf"); c.setAuthor("Pat Example"); c.setTitle("Flyer"); c.setCreator("Word 2021"); c.drawString(100,750,"Hello PDF"); c.drawImage(JPG,100,500,width=160,height=100); c.save()
import pikepdf
pdf=pikepdf.open(OUT+"/flyer.pdf",allow_overwriting_input=True)
with pdf.open_metadata() as m: m["dc:creator"]=["Pat Example"]; m["xmp:CreatorTool"]="Microsoft Word"
annot=pikepdf.Dictionary(Type=pikepdf.Name.Annot,Subtype=pikepdf.Name.Text,Rect=[50,50,70,70],Contents=pikepdf.String("note"),T=pikepdf.String("Pat Example"),M=pikepdf.String("D:20261108100000-07'00'"))
pdf.pages[0].Annots=pdf.make_indirect(pikepdf.Array([annot]))
pdf.attachments["secret.txt"]=pikepdf.AttachedFileSpec(pdf,b"hidden")
pdf.save(OUT+"/flyer.pdf")
# incremental revision appended (simulate "Save" in Acrobat)
raw=open(OUT+"/flyer.pdf","rb").read(); open(OUT+"/flyer.pdf","ab").write(b"\n% incremental\n%%EOF\n")
# ---- RTF / SVG
open(OUT+"/letter.rtf","w").write(r"{\rtf1\ansi{\info{\author Pat Example}{\operator pexample}{\company ACME}{\creatim\yr2026\mo11\dy7}}{\*\rsidtbl \rsid123}Hello RTF\par}")
open(OUT+"/logo.svg","w").write('<?xml version="1.0"?>\n<!-- Created with Inkscape -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="10" height="10" sodipodi:docname="logo.svg" inkscape:version="1.3" inkscape:export-filename="C:\\Users\\pexample\\Desktop\\logo.png"><metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Pat</dc:creator></rdf:RDF></metadata><rect width="10" height="10"/></svg>')
# ---- EPUB
with zipfile.ZipFile(OUT+"/book.epub","w") as z:
    z.writestr(zipfile.ZipInfo("mimetype",(2026,11,7,1,2,3)),"application/epub+zip")
    z.writestr("META-INF/container.xml",'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    z.writestr("OEBPS/content.opf",'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:1</dc:identifier><dc:title>My Book</dc:title><dc:creator>kultrshok</dc:creator><dc:contributor>calibre (7.0) [https://calibre-ebook.com]</dc:contributor><meta name="calibre:timestamp" content="2026-11-07T18:00:00"/><meta property="dcterms:modified">2026-11-07T18:00:00Z</meta></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="i" href="p.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="c"/></spine></package>')
    z.writestr("OEBPS/c.xhtml",'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>hi</p><img src="p.jpg"/></body></html>')
    z.writestr("OEBPS/p.jpg",open(JPG,"rb").read())
# ---- ZIP of stuff
with zipfile.ZipFile(OUT+"/bundle.zip","w") as z:
    z.write(JPG,"photos/PXL_20261107_183522.jpg"); z.write(OUT+"/budget.xlsx","budget.xlsx"); z.comment=b"zipped by pat"
# ---- audio
run=lambda *a: subprocess.run(["ffmpeg","-v","error","-y",*a],check=True)
run("-f","lavfi","-i","sine=f=440:d=0.5","-c:a","libmp3lame","-metadata","artist=Pat Example","-metadata","date=2026-11-07","-metadata","comment=recorded in backyard","/tmp/a.mp3")
run("-i","/tmp/a.mp3","-i",JPG,"-map","0","-map","1","-c","copy","-id3v2_version","3","-metadata:s:v","comment=Cover (front)","-disposition:v","attached_pic",OUT+"/song.mp3")
run("-f","lavfi","-i","sine=f=440:d=0.5","-c:a","aac","-metadata","artist=Pat Example","-metadata","creation_time=2026-11-07T18:00:00Z","-metadata","location=+33.4484-112.0740/",OUT+"/voice.m4a")
run("-f","lavfi","-i","sine=f=440:d=0.5","-metadata","artist=Pat Example","-metadata","date=2026",OUT+"/take.flac")
run("-f","lavfi","-i","sine=f=440:d=0.5","-metadata","artist=Pat Example","-metadata","ICMT=field rec",OUT+"/memo.wav")
print("ok")
# ---- PDF with a raw (EXIF-carrying) JPEG inside, and a plain leaky photo
import shutil
raw = open(JPG, "rb").read()
p2 = pikepdf.new(); p2.add_blank_page(page_size=(300, 300))
img = pikepdf.Stream(p2, raw); img.Type = pikepdf.Name.XObject; img.Subtype = pikepdf.Name.Image
img.Width = 320; img.Height = 200; img.ColorSpace = pikepdf.Name.DeviceRGB; img.BitsPerComponent = 8; img.Filter = pikepdf.Name.DCTDecode
pg = p2.pages[0]; pg.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img)); pg.Contents = p2.make_stream(b"q 160 0 0 100 10 10 cm /Im0 Do Q")
p2.docinfo["/Author"] = "Pat Example"; p2.save(OUT + "/photo.pdf")
shutil.copy(JPG, OUT + "/PXL_20261107_183522.jpg")
os.remove(JPG)
print("samples written to", OUT)
