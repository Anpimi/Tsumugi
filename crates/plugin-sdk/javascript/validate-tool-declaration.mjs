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
export const validate = validate223;
export default validate223;
const schema236 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"CapabilityToolDeclaration","description":"A package-local adapter to one declared, read-only capability. Input/output\ncontracts, limits and permissions are taken from that capability, rather\nthan repeated in a model-specific descriptor. A profile is an exact choice.","type":"object","properties":{"capabilityId":{"type":"string"},"description":{"type":"string"},"name":{"type":"string"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"skill":{"type":["string","null"]},"supportingResources":{"type":"array","items":{"type":"string"}},"title":{"type":"string"}},"additionalProperties":false,"required":["name","title","description","capabilityId","supportingResources"],"$defs":{"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]}}};
const schema237 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};

function validate223(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate223.evaluated;
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
validate223.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "capabilityId") || (key0 === "description")) || (key0 === "name")) || (key0 === "profile")) || (key0 === "skill")) || (key0 === "supportingResources")) || (key0 === "title"))){
validate223.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.capabilityId !== undefined){
const _errs2 = errors;
if(typeof data.capabilityId !== "string"){
validate223.errors = [{instancePath:instancePath+"/capabilityId",schemaPath:"#/properties/capabilityId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate223.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate223.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate223.errors = vErrors;
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
if(data.skill !== undefined){
let data7 = data.skill;
const _errs22 = errors;
if((typeof data7 !== "string") && (data7 !== null)){
validate223.errors = [{instancePath:instancePath+"/skill",schemaPath:"#/properties/skill/type",keyword:"type",params:{type: schema236.properties.skill.type},message:"must be string,null"}];
return false;
}
var valid0 = _errs22 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.supportingResources !== undefined){
let data8 = data.supportingResources;
const _errs24 = errors;
if(errors === _errs24){
if(Array.isArray(data8)){
var valid4 = true;
const len0 = data8.length;
for(let i0=0; i0<len0; i0++){
const _errs26 = errors;
if(typeof data8[i0] !== "string"){
validate223.errors = [{instancePath:instancePath+"/supportingResources/" + i0,schemaPath:"#/properties/supportingResources/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs26 === errors;
if(!valid4){
break;
}
}
}
else {
validate223.errors = [{instancePath:instancePath+"/supportingResources",schemaPath:"#/properties/supportingResources/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs24 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.title !== undefined){
const _errs28 = errors;
if(typeof data.title !== "string"){
validate223.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs28 === errors;
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
validate223.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate223.errors = vErrors;
return errors === 0;
}
validate223.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
