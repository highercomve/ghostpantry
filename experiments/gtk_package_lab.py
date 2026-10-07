#!/usr/bin/env python3
"""GTK4 viewer for real CPU detector runs from tune_packages.py.

Run with the system Python (PyGObject + cairo), separate from the ML venv:
python3 experiments/gtk_package_lab.py /tmp/ghostpantry-tuning/results.json
No model calls or inventory writes are mocked. This viewer evaluates proposals;
Android's Gemma classification/correction memory is not available here.
"""
import argparse
import json
from pathlib import Path

import gi
gi.require_version('Gtk','4.0')
gi.require_version('Gdk','4.0')
gi.require_version('GdkPixbuf','2.0')
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib


class PackageLab(Gtk.Application):
    def __init__(self, results, photo=None):
        super().__init__(application_id='dev.ghostpantry.PackageLab')
        self.results = results
        self.photo = photo
        self.connect('activate', self.activate)

    def activate(self, application):
        self.window = Gtk.ApplicationWindow(application=application,title='GhostPantry — Package Detection Lab')
        self.window.set_default_size(1100,900)
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=12)
        for side in ['top','bottom','start','end']:
            getattr(outer,f'set_margin_{side}')(16)
        self.window.set_child(outer)
        title = Gtk.Label(label='Package proposals · same pantry photo · desktop CPU',xalign=0)
        title.add_css_class('title-2')
        outer.append(title)
        controls = Gtk.Box(spacing=12)
        outer.append(controls)
        self.selection = Gtk.DropDown()
        self.selection.set_hexpand(True)
        self.selection.connect('notify::selected',self.changed)
        controls.append(self.selection)
        self.references_toggle = Gtk.CheckButton(label='Show draft reference boxes')
        self.references_toggle.set_active(True)
        self.references_toggle.connect('toggled',lambda _: self.canvas.queue_draw())
        controls.append(self.references_toggle)
        reload_button = Gtk.Button(label='Reload results')
        reload_button.connect('clicked',lambda _: self.reload())
        controls.append(reload_button)
        self.summary = Gtk.Label(xalign=0,wrap=True)
        outer.append(self.summary)
        body = Gtk.Box(spacing=18)
        body.set_vexpand(True)
        outer.append(body)
        self.canvas = Gtk.DrawingArea()
        self.canvas.set_hexpand(True)
        self.canvas.set_vexpand(True)
        self.canvas.set_draw_func(self.draw)
        body.append(self.canvas)
        scroller = Gtk.ScrolledWindow()
        scroller.set_size_request(290,-1)
        self.details = Gtk.Label(xalign=0,yalign=0,wrap=True,selectable=True)
        scroller.set_child(self.details)
        body.append(scroller)
        note = Gtk.Label(label='Orange: detector proposals. Green: approximate visible packages. Single-photo tuning; not held-out accuracy. No inventory changes.',wrap=True,xalign=0)
        outer.append(note)
        self.reload()
        self.window.present()

    def reload(self):
        try:
            data = json.loads(self.results.read_text())
            photo = self.photo or data.get('photo')
            if not photo:
                raise ValueError('Supply --photo for the portable report')
            pixbuf = GdkPixbuf.Pixbuf.new_from_file(str(photo))
            if [pixbuf.get_width(),pixbuf.get_height()] != data['photo_size']:
                raise ValueError('Photo dimensions do not match this report')
            runs = sorted(data['runs'], key=lambda r:(-r['matched_at_iou_50'],r['unmatched_proposals'],r['seconds']))
            if not runs:
                raise ValueError('No completed runs yet')
        except (OSError,ValueError,GLib.Error) as error:
            self.summary.set_text(f'Cannot load results: {error}')
            return
        self.data,self.pixbuf,self.runs = data,pixbuf,runs
        names = [f"{r['matched_at_iou_50']}/{r['reference_count']} · {len(r['boxes'])} boxes · {r['name']}" for r in runs]
        self.selection.set_model(Gtk.StringList.new(names))
        self.selection.set_selected(0)
        self.changed()

    def changed(self,*_):
        if not hasattr(self,'runs'):
            return
        index = self.selection.get_selected()
        if index >= len(self.runs):
            return
        self.run = self.runs[index]
        r = self.run
        self.summary.set_text(f"{r['matched_at_iou_50']}/{r['reference_count']} draft packages matched at IoU ≥ 0.50 · {r['unmatched_proposals']} unmatched proposals · {r['seconds']:.3f} s desktop · {len(self.runs)} configurations")
        lines = ['Best overlap per reference (IoU):']
        lines += [f'{name}: {score:.3f}' for name,score in r['best_iou_by_reference'].items()]
        lines += ['', 'Detector proposals:']
        lines += [f"{i+1}. {b['label']} · {b['score']:.3f}" for i,b in enumerate(r['boxes'])]
        self.details.set_text('\n\n'.join(lines))
        self.canvas.queue_draw()

    def draw(self,area,context,width,height):
        if not hasattr(self,'run'):
            return
        pw,ph = self.data['photo_size']
        scale = min(width/pw,height/ph)
        context.translate((width-pw*scale)/2,(height-ph*scale)/2)
        context.scale(scale,scale)
        Gdk.cairo_set_source_pixbuf(context,self.pixbuf,0,0)
        context.paint()
        groups = [(self.run['boxes'],(1,.65,0))]
        if self.references_toggle.get_active():
            groups.insert(0,(self.data['references'],(.25,1,.55)))
        context.set_font_size(13/scale)
        for boxes,color in groups:
            context.set_source_rgb(*color)
            context.set_line_width(2/scale)
            for index,box in enumerate(boxes):
                x,y,right,bottom = box['box']
                context.rectangle(x,y,right-x,bottom-y)
                context.stroke()
                context.move_to(x+3,y+16/scale)
                context.show_text(str(index+1))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results',type=Path)
    parser.add_argument('--photo',type=Path,help='Override the report photo path')
    args = parser.parse_args()
    PackageLab(args.results.resolve(),args.photo).run(None)
