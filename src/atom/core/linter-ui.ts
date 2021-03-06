/// <reference path="../../../typings/main.d.ts" />

import fs = require ('fs')
import path = require ('path')
import rp=require("raml-1-parser")
import hl=rp.hl;
import rr=rp.utils;

import _=require("underscore")
var TextBuffer=require("basarat-text-buffer")
import editorManager=require("./editorManager")
import editorTools=require("../editor-tools/editor-tools")
export var grammarScopes= ['source.raml']
export var scope= 'file'
export var lintOnFly= true;
var lintersToDestroy = [];
var linterApiProxy:any={};

var relint = function (editor:AtomCore.IEditor)  {
    var editorPath = editor.getPath && editor.getPath();

    var extName = editorPath && path.extname(editorPath);

    var lowerCase = extName && extName.toLowerCase();

    var linter = linterApiProxy.getEditorLinter(editor);
    lintersToDestroy.push(linter);

    if(lowerCase === '.raml' || lowerCase === '.yaml' ) {
        var res=lint(editor);

        if(!rr.hasAsyncRequests()) {
            linterApiProxy.setMessages(linter, res);

            console.log("Messages: " + res.length);
        }

        setupLinterCallback(editor, () => linterApiProxy.deleteMessages(linter));

        linter.onDidDestroy(() => {
            removeLinterCallback(editor);
        });

        editor.onDidDestroy(() => {
            destroyLinter(linterApiProxy, linter);
        });
    }
}
export function initEditorObservers(linterApi) {
    linterApiProxy=linterApi;
    rr.addLoadCallback(x => {
        atom.workspace.getTextEditors().forEach(x=>relint(x));

        var manager = editorTools.aquireManager();

        if(manager) {
            manager.updateDetails();
        }
    })
    atom.workspace.observeTextEditors(relint);
    return {
        dispose: () => {
            lintersToDestroy.forEach(linter => {
                destroyLinter(linterApi, linter);
            })
        }
    }
}

function destroyLinter(linterApi, linter) {
    linterApi.deleteMessages(linter);

    linterApi.deleteLinter(linter);
};

function setupLinterCallback(editor, callback) {
    editor.linterCallback = callback;
}

function removeLinterCallback(editor) {
    editor.linterCallback = null;
}

function execLinterCallback(editor) {
    if(editor.linterCallback) {
        editor.linterCallback();
        removeLinterCallback(editor);
    }
}


export function lint(textEditor:AtomCore.IEditor) {
    var result = actualLint(textEditor);

    if(rr.hasAsyncRequests()) {
        return [];
    }

    return result;
}

function isRAMLUnit(editor) {
    var contents = editor.getBuffer().getText();

    return contents.match(/^\s*#%RAML\s+(\d\.\d)\s*(\w*)\s*$/m);
}

function actualLint(textEditor:AtomCore.IEditor) {
    execLinterCallback(textEditor);

    if(rr.hasAsyncRequests()) {
        return [];
    }

    if (!isRAMLUnit(textEditor)) return [];

    var l=new Date().getTime();
    var astNode=editorManager.ast(textEditor);
    if (astNode==null){
        return [];
    }
    var result:any[]=[];
    var acceptor=new Acceptor(textEditor, result);
    var c=astNode.lowLevel() ? astNode.lowLevel().unit().contents() : "";
    var tab=0;
    while (true) {
        var tab:number = c.indexOf('\t',tab)
        if (tab != -1) {
            var p1 = textEditor.getBuffer().positionForCharacterIndex(tab);
            var p2 = textEditor.getBuffer().positionForCharacterIndex(tab + 1);
            var t = "Using tabs  can lead to unpredictable results";
            var message = {
                type: ("Warning"),
                filePath: textEditor.getPath(),
                text: t,
                trace: [],
                range: [[p1.row, p1.column], [p2.row, p2.column]]
            }
            result.push(message);
            tab++;
        }
        else{
            break;
        }
    }
    if (!astNode.lowLevel()){
        return [];
    }

    gatherValidationErrors(astNode,result,textEditor);

    var l1=new Date().getTime();
    var map={};
    result.forEach(x=>{
        var original=JSON.parse(JSON.stringify(x));
        original.trace=null;
        var newKey=JSON.stringify(original);
        var tr=map[newKey];
        if (tr){
            tr.push(x);
        }
        else{
            map[newKey]=[x];
        }
    });
    var rs:any[]=[];
    for (var i in map){
        var mes=JSON.parse(i);
        mes.trace=[];
        var ms=map[i];
        ms.forEach(x=>{
            if (x.trace){
                mes.trace=mes.trace.concat(x.trace);
            }
        })
        rs.push(mes);
    }
    if (editorTools.aquireManager()) {
        if (editorTools.aquireManager().performanceDebug) {
            console.log("Linting took:" + (l1 - l))
        }
    }
    return rs.filter(x=>x);
}
class Acceptor implements hl.ValidationAcceptor{

    constructor(private editor:AtomCore.IEditor,private errors:any[]){

    }
    buffers:{[path:string]:any}={}

    begin() {
    }

    accept(issue:hl.ValidationIssue) {
        if (!issue){
            return;
        }
        var p1=this.editor.getBuffer().positionForCharacterIndex(issue.start);
        var p2=this.editor.getBuffer().positionForCharacterIndex(issue.end);
        var t=issue.message;
        var pos=t.lastIndexOf(" at line ");
        if (pos!=-1){
            t=t.substring(0,pos);//it is message from yaml lets cut line info
        }
        var message = {type: (issue.isWarning?"Warning":'Error'),
            filePath:issue.path?issue.path:this.editor.getPath(),
            text: t,
            trace:[],
            range:[[p1.row,p1.column], [p2.row,p2.column]]}
        this.errors.push(message);
        if (issue.extras) {
            issue.extras.forEach(x=> {
                var t = x.message;
                var buf=this.editor.getBuffer();
                var ps=x.path;
                if (x.unit){
                    ps=x.unit.absolutePath();
                }
                if (ps){
                    if (this.buffers[ps]){
                        buf=this.buffers[ps];
                    }
                    else{
                        buf=new TextBuffer(x.unit.contents());
                        this.buffers[ps]=buf;

                    }
                }
                var p1 = buf.positionForCharacterIndex(x.start);
                var p2 = buf.positionForCharacterIndex(x.end);

                var trace = {
                    type: "Trace",
                    filePath: x.path ? ps : this.editor.getPath(),
                    text: t,
                    range: [[p1.row, p1.column], [p2.row, p2.column]]
                }
                message.trace.push(trace);
            })
        }
    }

    acceptUnique(issue:hl.ValidationIssue){
        this.accept(issue);
    }

    end() {
    }
}
function gatherValidationErrors(astNode:hl.IParseResult,errors:any[],editor:AtomCore.IEditor){
    if (astNode) {
        astNode.validate(new Acceptor(editor,errors))
    }
}
