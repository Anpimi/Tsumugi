// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
// Standalone generator: ajv 8.20.0 (MIT).
// The MIT License (MIT)
//
// Copyright (c) 2015-2021 Evgeny Poberezkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
"use strict";
export const validate = validate231;
export default validate231;
const schema247 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"CapabilityToolDeclaration","description":"A package-local adapter to one declared, read-only capability. Input/output\ncontracts, limits and permissions are taken from that capability, rather\nthan repeated in a model-specific descriptor. A profile is an exact choice.","type":"object","properties":{"capabilityId":{"type":"string"},"description":{"type":"string"},"name":{"type":"string"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"query":{"description":"Optional bounded semantic text-query presentation. It grants no access\nbeyond the original capability and remains untrusted package data.","anyOf":[{"$ref":"#/$defs/ToolQueryDeclaration"},{"type":"null"}]},"skill":{"type":["string","null"]},"supportingResources":{"type":"array","items":{"type":"string"}},"title":{"type":"string"}},"additionalProperties":false,"required":["name","title","description","capabilityId","supportingResources"],"$defs":{"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"ToolQueryColumn":{"type":"object","properties":{"label":{"type":"string"},"path":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["label","path"]},"ToolQueryDeclaration":{"type":"object","properties":{"inputSchema":{"$ref":"#/$defs/ContractRef"},"inputTemplate":true,"maxTextBytes":{"type":"integer","maximum":4294967295,"minimum":1},"output":{"$ref":"#/$defs/ToolQueryOutput"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"selections":{"description":"Explicit senses or categories. Matching text alone does not select them.","$ref":"#/$defs/ToolQuerySelection"},"target":{"description":"One explicit target option; no host-side locale or value normalization.","$ref":"#/$defs/ToolQuerySelection"},"textPath":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["inputSchema","outputSchema","inputTemplate","textPath","maxTextBytes","target","selections","output"]},"ToolQueryOption":{"type":"object","properties":{"description":{"type":"string"},"label":{"type":"string"},"value":{"type":"string"}},"additionalProperties":false,"required":["value","label","description"]},"ToolQueryOutput":{"type":"object","properties":{"columns":{"type":"array","items":{"$ref":"#/$defs/ToolQueryColumn"}},"emptyDescription":{"type":"string"},"entriesPath":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}},"maxEntries":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["entriesPath","columns","maxEntries","emptyDescription"]},"ToolQueryPathPart":{"anyOf":[{"type":"string"},{"type":"integer","maximum":1999,"minimum":0}]},"ToolQuerySelection":{"type":"object","properties":{"description":{"type":"string"},"label":{"type":"string"},"maxSelected":{"type":"integer","maximum":4294967295,"minimum":1},"minSelected":{"type":"integer","maximum":64,"minimum":0},"options":{"type":"array","items":{"$ref":"#/$defs/ToolQueryOption"}},"path":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["label","description","path","options","minSelected","maxSelected"]}}};
const schema248 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema249 = {"type":"object","properties":{"inputSchema":{"$ref":"#/$defs/ContractRef"},"inputTemplate":true,"maxTextBytes":{"type":"integer","maximum":4294967295,"minimum":1},"output":{"$ref":"#/$defs/ToolQueryOutput"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"selections":{"description":"Explicit senses or categories. Matching text alone does not select them.","$ref":"#/$defs/ToolQuerySelection"},"target":{"description":"One explicit target option; no host-side locale or value normalization.","$ref":"#/$defs/ToolQuerySelection"},"textPath":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["inputSchema","outputSchema","inputTemplate","textPath","maxTextBytes","target","selections","output"]};
const schema253 = {"anyOf":[{"type":"string"},{"type":"integer","maximum":1999,"minimum":0}]};
const schema251 = {"type":"object","properties":{"columns":{"type":"array","items":{"$ref":"#/$defs/ToolQueryColumn"}},"emptyDescription":{"type":"string"},"entriesPath":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}},"maxEntries":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["entriesPath","columns","maxEntries","emptyDescription"]};
const schema252 = {"type":"object","properties":{"label":{"type":"string"},"path":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["label","path"]};

function validate234(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate234.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.label === undefined) && (missing0 = "label")) || ((data.path === undefined) && (missing0 = "path"))){
validate234.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "label") || (key0 === "path"))){
validate234.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.label !== undefined){
const _errs2 = errors;
if(typeof data.label !== "string"){
validate234.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.path !== undefined){
let data1 = data.path;
const _errs4 = errors;
if(errors === _errs4){
if(Array.isArray(data1)){
var valid1 = true;
const len0 = data1.length;
for(let i0=0; i0<len0; i0++){
let data2 = data1[i0];
const _errs6 = errors;
const _errs8 = errors;
let valid3 = false;
const _errs9 = errors;
if(typeof data2 !== "string"){
const err0 = {instancePath:instancePath+"/path/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs9 === errors;
valid3 = valid3 || _valid0;
const _errs11 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
const err1 = {instancePath:instancePath+"/path/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(errors === _errs11){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 1999 || isNaN(data2)){
const err2 = {instancePath:instancePath+"/path/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1999},message:"must be <= 1999"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
else {
if(data2 < 0 || isNaN(data2)){
const err3 = {instancePath:instancePath+"/path/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
}
}
var _valid0 = _errs11 === errors;
valid3 = valid3 || _valid0;
if(!valid3){
const err4 = {instancePath:instancePath+"/path/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
validate234.errors = vErrors;
return false;
}
else {
errors = _errs8;
if(vErrors !== null){
if(_errs8){
vErrors.length = _errs8;
}
else {
vErrors = null;
}
}
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate234.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate234.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate234.errors = vErrors;
return errors === 0;
}
validate234.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate233(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate233.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.entriesPath === undefined) && (missing0 = "entriesPath")) || ((data.columns === undefined) && (missing0 = "columns"))) || ((data.maxEntries === undefined) && (missing0 = "maxEntries"))) || ((data.emptyDescription === undefined) && (missing0 = "emptyDescription"))){
validate233.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "columns") || (key0 === "emptyDescription")) || (key0 === "entriesPath")) || (key0 === "maxEntries"))){
validate233.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.columns !== undefined){
let data0 = data.columns;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(!(validate234(data0[i0], {instancePath:instancePath+"/columns/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate234.errors : vErrors.concat(validate234.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.emptyDescription !== undefined){
const _errs5 = errors;
if(typeof data.emptyDescription !== "string"){
validate233.errors = [{instancePath:instancePath+"/emptyDescription",schemaPath:"#/properties/emptyDescription/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.entriesPath !== undefined){
let data3 = data.entriesPath;
const _errs7 = errors;
if(errors === _errs7){
if(Array.isArray(data3)){
var valid2 = true;
const len1 = data3.length;
for(let i1=0; i1<len1; i1++){
let data4 = data3[i1];
const _errs9 = errors;
const _errs11 = errors;
let valid4 = false;
const _errs12 = errors;
if(typeof data4 !== "string"){
const err0 = {instancePath:instancePath+"/entriesPath/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs12 === errors;
valid4 = valid4 || _valid0;
const _errs14 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
const err1 = {instancePath:instancePath+"/entriesPath/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(errors === _errs14){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 1999 || isNaN(data4)){
const err2 = {instancePath:instancePath+"/entriesPath/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1999},message:"must be <= 1999"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
else {
if(data4 < 0 || isNaN(data4)){
const err3 = {instancePath:instancePath+"/entriesPath/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
}
}
var _valid0 = _errs14 === errors;
valid4 = valid4 || _valid0;
if(!valid4){
const err4 = {instancePath:instancePath+"/entriesPath/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
validate233.errors = vErrors;
return false;
}
else {
errors = _errs11;
if(vErrors !== null){
if(_errs11){
vErrors.length = _errs11;
}
else {
vErrors = null;
}
}
}
var valid2 = _errs9 === errors;
if(!valid2){
break;
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/entriesPath",schemaPath:"#/properties/entriesPath/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.maxEntries !== undefined){
let data5 = data.maxEntries;
const _errs16 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate233.errors = [{instancePath:instancePath+"/maxEntries",schemaPath:"#/properties/maxEntries/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs16){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate233.errors = [{instancePath:instancePath+"/maxEntries",schemaPath:"#/properties/maxEntries/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate233.errors = [{instancePath:instancePath+"/maxEntries",schemaPath:"#/properties/maxEntries/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid0 = _errs16 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
else {
validate233.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate233.errors = vErrors;
return errors === 0;
}
validate233.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema256 = {"type":"object","properties":{"description":{"type":"string"},"label":{"type":"string"},"maxSelected":{"type":"integer","maximum":4294967295,"minimum":1},"minSelected":{"type":"integer","maximum":64,"minimum":0},"options":{"type":"array","items":{"$ref":"#/$defs/ToolQueryOption"}},"path":{"type":"array","items":{"$ref":"#/$defs/ToolQueryPathPart"}}},"additionalProperties":false,"required":["label","description","path","options","minSelected","maxSelected"]};
const schema257 = {"type":"object","properties":{"description":{"type":"string"},"label":{"type":"string"},"value":{"type":"string"}},"additionalProperties":false,"required":["value","label","description"]};

function validate237(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate237.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.label === undefined) && (missing0 = "label")) || ((data.description === undefined) && (missing0 = "description"))) || ((data.path === undefined) && (missing0 = "path"))) || ((data.options === undefined) && (missing0 = "options"))) || ((data.minSelected === undefined) && (missing0 = "minSelected"))) || ((data.maxSelected === undefined) && (missing0 = "maxSelected"))){
validate237.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "description") || (key0 === "label")) || (key0 === "maxSelected")) || (key0 === "minSelected")) || (key0 === "options")) || (key0 === "path"))){
validate237.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.description !== undefined){
const _errs2 = errors;
if(typeof data.description !== "string"){
validate237.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.label !== undefined){
const _errs4 = errors;
if(typeof data.label !== "string"){
validate237.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.maxSelected !== undefined){
let data2 = data.maxSelected;
const _errs6 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate237.errors = [{instancePath:instancePath+"/maxSelected",schemaPath:"#/properties/maxSelected/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate237.errors = [{instancePath:instancePath+"/maxSelected",schemaPath:"#/properties/maxSelected/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate237.errors = [{instancePath:instancePath+"/maxSelected",schemaPath:"#/properties/maxSelected/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.minSelected !== undefined){
let data3 = data.minSelected;
const _errs8 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate237.errors = [{instancePath:instancePath+"/minSelected",schemaPath:"#/properties/minSelected/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 64 || isNaN(data3)){
validate237.errors = [{instancePath:instancePath+"/minSelected",schemaPath:"#/properties/minSelected/maximum",keyword:"maximum",params:{comparison: "<=", limit: 64},message:"must be <= 64"}];
return false;
}
else {
if(data3 < 0 || isNaN(data3)){
validate237.errors = [{instancePath:instancePath+"/minSelected",schemaPath:"#/properties/minSelected/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.options !== undefined){
let data4 = data.options;
const _errs10 = errors;
if(errors === _errs10){
if(Array.isArray(data4)){
var valid1 = true;
const len0 = data4.length;
for(let i0=0; i0<len0; i0++){
let data5 = data4[i0];
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data5 && typeof data5 == "object" && !Array.isArray(data5)){
let missing1;
if((((data5.value === undefined) && (missing1 = "value")) || ((data5.label === undefined) && (missing1 = "label"))) || ((data5.description === undefined) && (missing1 = "description"))){
validate237.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/ToolQueryOption/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key1 in data5){
if(!(((key1 === "description") || (key1 === "label")) || (key1 === "value"))){
validate237.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/ToolQueryOption/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data5.description !== undefined){
const _errs16 = errors;
if(typeof data5.description !== "string"){
validate237.errors = [{instancePath:instancePath+"/options/" + i0+"/description",schemaPath:"#/$defs/ToolQueryOption/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data5.label !== undefined){
const _errs18 = errors;
if(typeof data5.label !== "string"){
validate237.errors = [{instancePath:instancePath+"/options/" + i0+"/label",schemaPath:"#/$defs/ToolQueryOption/properties/label/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs18 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data5.value !== undefined){
const _errs20 = errors;
if(typeof data5.value !== "string"){
validate237.errors = [{instancePath:instancePath+"/options/" + i0+"/value",schemaPath:"#/$defs/ToolQueryOption/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs20 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
validate237.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/ToolQueryOption/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid1 = _errs12 === errors;
if(!valid1){
break;
}
}
}
else {
validate237.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.path !== undefined){
let data9 = data.path;
const _errs22 = errors;
if(errors === _errs22){
if(Array.isArray(data9)){
var valid4 = true;
const len1 = data9.length;
for(let i1=0; i1<len1; i1++){
let data10 = data9[i1];
const _errs24 = errors;
const _errs26 = errors;
let valid6 = false;
const _errs27 = errors;
if(typeof data10 !== "string"){
const err0 = {instancePath:instancePath+"/path/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs27 === errors;
valid6 = valid6 || _valid0;
const _errs29 = errors;
if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){
const err1 = {instancePath:instancePath+"/path/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(errors === _errs29){
if((typeof data10 == "number") && (isFinite(data10))){
if(data10 > 1999 || isNaN(data10)){
const err2 = {instancePath:instancePath+"/path/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1999},message:"must be <= 1999"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
else {
if(data10 < 0 || isNaN(data10)){
const err3 = {instancePath:instancePath+"/path/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
}
}
var _valid0 = _errs29 === errors;
valid6 = valid6 || _valid0;
if(!valid6){
const err4 = {instancePath:instancePath+"/path/" + i1,schemaPath:"#/$defs/ToolQueryPathPart/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
validate237.errors = vErrors;
return false;
}
else {
errors = _errs26;
if(vErrors !== null){
if(_errs26){
vErrors.length = _errs26;
}
else {
vErrors = null;
}
}
}
var valid4 = _errs24 === errors;
if(!valid4){
break;
}
}
}
else {
validate237.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs22 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
}
else {
validate237.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate237.errors = vErrors;
return errors === 0;
}
validate237.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate232(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate232.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((((data.inputSchema === undefined) && (missing0 = "inputSchema")) || ((data.outputSchema === undefined) && (missing0 = "outputSchema"))) || ((data.inputTemplate === undefined) && (missing0 = "inputTemplate"))) || ((data.textPath === undefined) && (missing0 = "textPath"))) || ((data.maxTextBytes === undefined) && (missing0 = "maxTextBytes"))) || ((data.target === undefined) && (missing0 = "target"))) || ((data.selections === undefined) && (missing0 = "selections"))) || ((data.output === undefined) && (missing0 = "output"))){
validate232.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "inputSchema") || (key0 === "inputTemplate")) || (key0 === "maxTextBytes")) || (key0 === "output")) || (key0 === "outputSchema")) || (key0 === "selections")) || (key0 === "target")) || (key0 === "textPath"))){
validate232.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.inputSchema !== undefined){
let data0 = data.inputSchema;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate232.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate232.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate232.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate232.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate232.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate232.errors = [{instancePath:instancePath+"/inputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate232.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate232.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate232.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate232.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.maxTextBytes !== undefined){
let data4 = data.maxTextBytes;
const _errs12 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate232.errors = [{instancePath:instancePath+"/maxTextBytes",schemaPath:"#/properties/maxTextBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate232.errors = [{instancePath:instancePath+"/maxTextBytes",schemaPath:"#/properties/maxTextBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate232.errors = [{instancePath:instancePath+"/maxTextBytes",schemaPath:"#/properties/maxTextBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.output !== undefined){
const _errs14 = errors;
if(!(validate233(data.output, {instancePath:instancePath+"/output",parentData:data,parentDataProperty:"output",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate233.errors : vErrors.concat(validate233.errors);
errors = vErrors.length;
}
var valid0 = _errs14 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputSchema !== undefined){
let data6 = data.outputSchema;
const _errs15 = errors;
const _errs16 = errors;
if(errors === _errs16){
if(data6 && typeof data6 == "object" && !Array.isArray(data6)){
let missing2;
if((((data6.id === undefined) && (missing2 = "id")) || ((data6.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data6.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate232.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs18 = errors;
for(const key2 in data6){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate232.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs18 === errors){
if(data6.behaviorVersion !== undefined){
let data7 = data6.behaviorVersion;
const _errs19 = errors;
if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){
validate232.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs19){
if((typeof data7 == "number") && (isFinite(data7))){
if(data7 > 4294967295 || isNaN(data7)){
validate232.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data7 < 1 || isNaN(data7)){
validate232.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data6.id !== undefined){
const _errs21 = errors;
if(typeof data6.id !== "string"){
validate232.errors = [{instancePath:instancePath+"/outputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data6.schemaVersion !== undefined){
let data9 = data6.schemaVersion;
const _errs23 = errors;
if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){
validate232.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs23){
if((typeof data9 == "number") && (isFinite(data9))){
if(data9 > 4294967295 || isNaN(data9)){
validate232.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data9 < 1 || isNaN(data9)){
validate232.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
else {
validate232.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.selections !== undefined){
const _errs25 = errors;
if(!(validate237(data.selections, {instancePath:instancePath+"/selections",parentData:data,parentDataProperty:"selections",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate237.errors : vErrors.concat(validate237.errors);
errors = vErrors.length;
}
var valid0 = _errs25 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.target !== undefined){
const _errs26 = errors;
if(!(validate237(data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate237.errors : vErrors.concat(validate237.errors);
errors = vErrors.length;
}
var valid0 = _errs26 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.textPath !== undefined){
let data12 = data.textPath;
const _errs27 = errors;
if(errors === _errs27){
if(Array.isArray(data12)){
var valid5 = true;
const len0 = data12.length;
for(let i0=0; i0<len0; i0++){
let data13 = data12[i0];
const _errs29 = errors;
const _errs31 = errors;
let valid7 = false;
const _errs32 = errors;
if(typeof data13 !== "string"){
const err0 = {instancePath:instancePath+"/textPath/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs32 === errors;
valid7 = valid7 || _valid0;
const _errs34 = errors;
if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){
const err1 = {instancePath:instancePath+"/textPath/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(errors === _errs34){
if((typeof data13 == "number") && (isFinite(data13))){
if(data13 > 1999 || isNaN(data13)){
const err2 = {instancePath:instancePath+"/textPath/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1999},message:"must be <= 1999"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
else {
if(data13 < 0 || isNaN(data13)){
const err3 = {instancePath:instancePath+"/textPath/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf/1/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
}
}
var _valid0 = _errs34 === errors;
valid7 = valid7 || _valid0;
if(!valid7){
const err4 = {instancePath:instancePath+"/textPath/" + i0,schemaPath:"#/$defs/ToolQueryPathPart/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
validate232.errors = vErrors;
return false;
}
else {
errors = _errs31;
if(vErrors !== null){
if(_errs31){
vErrors.length = _errs31;
}
else {
vErrors = null;
}
}
}
var valid5 = _errs29 === errors;
if(!valid5){
break;
}
}
}
else {
validate232.errors = [{instancePath:instancePath+"/textPath",schemaPath:"#/properties/textPath/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs27 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
}
}
else {
validate232.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate232.errors = vErrors;
return errors === 0;
}
validate232.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate231(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate231.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.name === undefined) && (missing0 = "name")) || ((data.title === undefined) && (missing0 = "title"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.capabilityId === undefined) && (missing0 = "capabilityId"))) || ((data.supportingResources === undefined) && (missing0 = "supportingResources"))){
validate231.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "capabilityId") || (key0 === "description")) || (key0 === "name")) || (key0 === "profile")) || (key0 === "query")) || (key0 === "skill")) || (key0 === "supportingResources")) || (key0 === "title"))){
validate231.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.capabilityId !== undefined){
const _errs2 = errors;
if(typeof data.capabilityId !== "string"){
validate231.errors = [{instancePath:instancePath+"/capabilityId",schemaPath:"#/properties/capabilityId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.description !== undefined){
const _errs4 = errors;
if(typeof data.description !== "string"){
validate231.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.name !== undefined){
const _errs6 = errors;
if(typeof data.name !== "string"){
validate231.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data3 = data.profile;
const _errs8 = errors;
const _errs9 = errors;
let valid1 = false;
const _errs10 = errors;
const _errs11 = errors;
if(errors === _errs11){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if((((data3.id === undefined) && (missing1 = "id")) || ((data3.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data3.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
const err0 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs13 = errors;
for(const key1 in data3){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
const err1 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs13 === errors){
if(data3.behaviorVersion !== undefined){
let data4 = data3.behaviorVersion;
const _errs14 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
const err2 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(errors === _errs14){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
const err3 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
else {
if(data4 < 1 || isNaN(data4)){
const err4 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data3.id !== undefined){
const _errs16 = errors;
if(typeof data3.id !== "string"){
const err5 = {instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data3.schemaVersion !== undefined){
let data6 = data3.schemaVersion;
const _errs18 = errors;
if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){
const err6 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs18){
if((typeof data6 == "number") && (isFinite(data6))){
if(data6 > 4294967295 || isNaN(data6)){
const err7 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data6 < 1 || isNaN(data6)){
const err8 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
}
}
var valid3 = _errs18 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
const err9 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid0 = _errs10 === errors;
valid1 = valid1 || _valid0;
const _errs20 = errors;
if(data3 !== null){
const err10 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var _valid0 = _errs20 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err11 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
validate231.errors = vErrors;
return false;
}
else {
errors = _errs9;
if(vErrors !== null){
if(_errs9){
vErrors.length = _errs9;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.query !== undefined){
let data7 = data.query;
const _errs22 = errors;
const _errs23 = errors;
let valid4 = false;
const _errs24 = errors;
if(!(validate232(data7, {instancePath:instancePath+"/query",parentData:data,parentDataProperty:"query",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate232.errors : vErrors.concat(validate232.errors);
errors = vErrors.length;
}
var _valid1 = _errs24 === errors;
valid4 = valid4 || _valid1;
const _errs25 = errors;
if(data7 !== null){
const err12 = {instancePath:instancePath+"/query",schemaPath:"#/properties/query/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
var _valid1 = _errs25 === errors;
valid4 = valid4 || _valid1;
if(!valid4){
const err13 = {instancePath:instancePath+"/query",schemaPath:"#/properties/query/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
validate231.errors = vErrors;
return false;
}
else {
errors = _errs23;
if(vErrors !== null){
if(_errs23){
vErrors.length = _errs23;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs22 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.skill !== undefined){
let data8 = data.skill;
const _errs27 = errors;
if((typeof data8 !== "string") && (data8 !== null)){
validate231.errors = [{instancePath:instancePath+"/skill",schemaPath:"#/properties/skill/type",keyword:"type",params:{type: schema247.properties.skill.type},message:"must be string,null"}];
return false;
}
var valid0 = _errs27 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.supportingResources !== undefined){
let data9 = data.supportingResources;
const _errs29 = errors;
if(errors === _errs29){
if(Array.isArray(data9)){
var valid5 = true;
const len0 = data9.length;
for(let i0=0; i0<len0; i0++){
const _errs31 = errors;
if(typeof data9[i0] !== "string"){
validate231.errors = [{instancePath:instancePath+"/supportingResources/" + i0,schemaPath:"#/properties/supportingResources/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid5 = _errs31 === errors;
if(!valid5){
break;
}
}
}
else {
validate231.errors = [{instancePath:instancePath+"/supportingResources",schemaPath:"#/properties/supportingResources/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs29 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.title !== undefined){
const _errs33 = errors;
if(typeof data.title !== "string"){
validate231.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs33 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
}
}
}
else {
validate231.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate231.errors = vErrors;
return errors === 0;
}
validate231.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
